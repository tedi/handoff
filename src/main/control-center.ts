import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import chokidar from "chokidar"

import { buildConversationTranscript } from "../shared/parser"
import type {
  ControlCenterActionResult,
  ControlCenterPendingRequest,
  ControlCenterPendingRequestAction,
  ControlCenterPendingRequestActionability,
  ControlCenterPendingRequestPreview,
  ControlCenterPendingRequestPreviewLine,
  ControlCenterSnapshot,
  ControlCenterStateChangeEvent,
  LiveAssistantPreviewKind,
  LiveThreadEvent,
  LiveThreadRecord,
  LiveThreadStatus,
  SessionClient,
  SessionIndexEntry,
  SessionListItem,
  SessionProvider,
  TerminalAppId,
  ThreadLaunchMode
} from "../shared/contracts"

const execFileAsync = promisify(execFile)

export const CONTROL_CENTER_HOOK_MODE_ARG = "--control-center-hook"

export const CONTROL_CENTER_CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop"
] as const

export const CONTROL_CENTER_CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "PermissionRequest",
  "Notification",
  "SubagentStart",
  "SubagentStop"
] as const

const DEFAULT_SOUND_PATH = "/System/Library/Sounds/Glass.aiff"
const GLOBAL_SOUND_DEBOUNCE_MS = 900
const THREAD_SOUND_DEBOUNCE_MS = 12_000
const PREVIEW_MAX_LENGTH = 220
const LIVE_HOOK_COMMAND_MARKER = CONTROL_CENTER_HOOK_MODE_ARG

type SupportedHookEvent = (typeof CONTROL_CENTER_CODEX_EVENTS)[number] | (typeof CONTROL_CENTER_CLAUDE_EVENTS)[number]
type StoredHostAppId = TerminalAppId | "codex-app" | null

type StoredRequestHookKind = "permission" | "pretool"

type StoredRequestActionExecution =
  | {
      type: "hook-response"
      hookKind: StoredRequestHookKind
      permissionDecision?: "allow" | "deny" | "defer"
      updatedInput?: Record<string, unknown> | null
      updatedPermissions?: Array<Record<string, unknown>> | null
    }
  | {
      type: "terminal-submit"
      submissionText: string
      submitWithEnter: boolean
    }
  | {
      type: "open-only"
    }

interface StoredPendingRequestAction extends ControlCenterPendingRequestAction {
  execution: StoredRequestActionExecution
}

interface StoredPendingRequest extends Omit<ControlCenterPendingRequest, "actions"> {
  actions: StoredPendingRequestAction[]
}

type HookResolutionEnvelope =
  | {
      type: "hook-response"
      hookSpecificOutput: Record<string, unknown>
    }
  | {
      type: "delegate-to-provider"
    }

type HookSocketClientMessage = {
  type: "event"
  awaitResolution: boolean
  event: NormalizedLiveHookEvent
}

type HookSocketServerMessage =
  | {
      type: "ack"
    }
  | {
      type: "resolve"
      resolution: HookResolutionEnvelope
    }

interface HookCommandConfig {
  command: string
  args: string[]
}

type NormalizedLiveHookEvent = Omit<LiveThreadEvent, "pendingRequest"> & {
  pendingRequest: StoredPendingRequest | null
  hostAppId: StoredHostAppId
}

type StoredLiveThreadRecord = Omit<LiveThreadRecord, "pendingRequest"> & {
  pendingRequest: StoredPendingRequest | null
  hostAppId: StoredHostAppId
  lastSoundStatus: LiveThreadStatus | null
  lastSoundAt: string | null
}

export type ControlCenterStoredThreadRecord = StoredLiveThreadRecord

interface PersistedControlCenterState {
  version: 1
  records: StoredLiveThreadRecord[]
}

export interface ControlCenterServiceOptions {
  dataDir: string
  onPlaySound?: (record: LiveThreadRecord) => Promise<void> | void
}

export interface ControlCenterService {
  getSnapshot(): Promise<ControlCenterSnapshot>
  getRecord(id: string): Promise<StoredLiveThreadRecord | null>
  acknowledge(id: string): Promise<StoredLiveThreadRecord | null>
  delegatePendingRequest(id: string): Promise<StoredLiveThreadRecord | null>
  performAction(
    threadId: string,
    requestId: string,
    actionId: string
  ): Promise<ControlCenterActionResult>
  dismiss(id: string): Promise<ControlCenterSnapshot>
  dismissCompleted(): Promise<ControlCenterSnapshot>
  reconcileSessions(sessions: SessionListItem[]): Promise<void>
  ingestHookEvent(event: LiveThreadEvent): Promise<void>
  startWatching(): Promise<void>
  onStateChanged(listener: (event: ControlCenterStateChangeEvent) => void): () => void
  dispose(): Promise<void>
}

function shellEscape(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function normalizeTextPreview(value: string | null | undefined) {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.length <= PREVIEW_MAX_LENGTH) {
    return trimmed
  }

  return `${trimmed.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`
}

function buildDefaultThreadName(provider: SessionProvider) {
  return provider === "claude" ? "Claude conversation" : "Codex conversation"
}

function isFallbackThreadName(provider: SessionProvider, value: string | null | undefined) {
  const normalizedValue = value?.trim() ?? ""
  return !normalizedValue || normalizedValue === buildDefaultThreadName(provider)
}

function createLiveThreadId(provider: SessionProvider, sourceSessionId: string) {
  return `${provider}:${sourceSessionId}`
}

function buildSocketPath(dataDir: string) {
  const hash = createHash("sha1").update(dataDir).digest("hex").slice(0, 12)
  return path.join(os.tmpdir(), `handoff-cc-${hash}.sock`)
}

function getControlCenterStatePaths(dataDir: string) {
  const rootDir = path.join(dataDir, "control-center")
  return {
    rootDir,
    recordsPath: path.join(rootDir, "live-threads.json"),
    spoolPath: path.join(rootDir, "hook-events.jsonl"),
    socketPath: buildSocketPath(dataDir)
  }
}

function getRecordSortWeight(status: LiveThreadStatus) {
  if (status === "waiting_permission") {
    return 0
  }

  if (status === "waiting_user") {
    return 1
  }

  if (status === "running") {
    return 2
  }

  if (status === "completed") {
    return 3
  }

  return 4
}

function sortLiveThreadRecords(records: LiveThreadRecord[]) {
  return [...records].sort((left, right) => {
    const weightDiff = getRecordSortWeight(left.status) - getRecordSortWeight(right.status)
    if (weightDiff !== 0) {
      return weightDiff
    }

    return right.lastEventAt.localeCompare(left.lastEventAt)
  })
}

function serializePendingRequestPreviewLine(
  line: ControlCenterPendingRequestPreviewLine
): ControlCenterPendingRequestPreviewLine {
  return {
    kind: line.kind,
    text: line.text
  }
}

function serializePendingRequestPreview(
  preview: ControlCenterPendingRequestPreview | null
): ControlCenterPendingRequestPreview | null {
  if (!preview) {
    return null
  }

  if (preview.type === "diff") {
    return {
      type: "diff",
      title: preview.title,
      target: preview.target,
      addedLineCount: preview.addedLineCount,
      removedLineCount: preview.removedLineCount,
      lines: preview.lines.map(serializePendingRequestPreviewLine)
    }
  }

  if (preview.type === "command") {
    return {
      type: "command",
      command: preview.command
    }
  }

  return {
    type: "summary",
    summary: preview.summary
  }
}

function serializePendingRequestAction(
  action: StoredPendingRequestAction
): ControlCenterPendingRequestAction {
  return {
    id: action.id,
    label: action.label,
    kind: action.kind,
    acceleratorHint: action.acceleratorHint,
    primary: action.primary
  }
}

function serializePendingRequest(
  pendingRequest: StoredPendingRequest | null
): ControlCenterPendingRequest | null {
  if (!pendingRequest) {
    return null
  }

  return {
    requestId: pendingRequest.requestId,
    provider: pendingRequest.provider,
    type: pendingRequest.type,
    title: pendingRequest.title,
    prompt: pendingRequest.prompt,
    actions: pendingRequest.actions.map(serializePendingRequestAction),
    preview: serializePendingRequestPreview(pendingRequest.preview),
    actionability: pendingRequest.actionability
  }
}

function serializeRecord(record: StoredLiveThreadRecord): LiveThreadRecord {
  return {
    id: record.id,
    provider: record.provider,
    sourceSessionId: record.sourceSessionId,
    threadName: record.threadName,
    projectPath: record.projectPath,
    transcriptPath: record.transcriptPath,
    status: record.status,
    lastEventAt: record.lastEventAt,
    lastUserPreview: record.lastUserPreview,
    lastAssistantPreview: record.lastAssistantPreview,
    assistantPreviewKind: record.assistantPreviewKind,
    launchMode: record.launchMode,
    hostAppLabel: record.hostAppLabel,
    hostAppExact: record.hostAppExact,
    pendingRequest: serializePendingRequest(record.pendingRequest),
    acknowledgedAt: record.acknowledgedAt,
    dismissedAt: record.dismissedAt
  }
}

function readPathValue(
  input: Record<string, unknown>,
  pathSegments: string[]
): unknown {
  let current: unknown = input
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return null
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

function findFirstString(
  input: Record<string, unknown>,
  candidatePaths: string[][]
) {
  for (const candidatePath of candidatePaths) {
    const value = readPathValue(input, candidatePath)
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function findFirstNumber(
  input: Record<string, unknown>,
  candidatePaths: string[][]
) {
  for (const candidatePath of candidatePaths) {
    const value = readPathValue(input, candidatePath)
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
  }

  return null
}

function mapExplicitStatus(value: string | null) {
  const normalizedValue = value?.trim().toLowerCase() ?? ""

  if (
    normalizedValue === "waiting_user" ||
    normalizedValue === "waiting-for-user" ||
    normalizedValue === "needs_input"
  ) {
    return "waiting_user" as const
  }

  if (
    normalizedValue === "waiting_permission" ||
    normalizedValue === "waiting-for-permission" ||
    normalizedValue === "permission"
  ) {
    return "waiting_permission" as const
  }

  if (
    normalizedValue === "completed" ||
    normalizedValue === "complete" ||
    normalizedValue === "done" ||
    normalizedValue === "success"
  ) {
    return "completed" as const
  }

  if (normalizedValue === "failed" || normalizedValue === "error") {
    return "failed" as const
  }

  if (normalizedValue === "running" || normalizedValue === "active") {
    return "running" as const
  }

  return null
}

function buildHookReasonText(input: Record<string, unknown>) {
  const fields = [
    findFirstString(input, [["stop_reason"]]),
    findFirstString(input, [["reason"]]),
    findFirstString(input, [["notification_type"]]),
    findFirstString(input, [["message"]]),
    findFirstString(input, [["title"]]),
    findFirstString(input, [["payload", "stop_reason"]]),
    findFirstString(input, [["payload", "reason"]]),
    findFirstString(input, [["payload", "notification_type"]]),
    findFirstString(input, [["payload", "message"]]),
    findFirstString(input, [["payload", "title"]])
  ]
    .filter((field): field is string => Boolean(field))
    .join(" ")

  return fields.toLowerCase()
}

function inferWaitingUserFromReason(reasonText: string) {
  const waitingUserPhrases = [
    "waiting for your input",
    "waiting for input",
    "needs input",
    "needs reply",
    "needs response",
    "waiting for a reply",
    "waiting for a response",
    "waiting on user",
    "waiting on your response",
    "your input",
    "your response",
    "clarification"
  ]

  return waitingUserPhrases.some(phrase => reasonText.includes(phrase))
}

export function classifyLiveThreadStatusFromHook(params: {
  eventName: string
  payload: Record<string, unknown>
}) {
  const explicitStatus = mapExplicitStatus(
    findFirstString(params.payload, [
      ["status"],
      ["state"],
      ["payload", "status"],
      ["payload", "state"],
      ["result", "status"]
    ])
  )
  if (explicitStatus) {
    return explicitStatus
  }

  const exitCode = findFirstNumber(params.payload, [["exit_code"], ["payload", "exit_code"]])
  if (exitCode !== null && exitCode !== 0) {
    return "failed" as const
  }

  const errorText = findFirstString(params.payload, [["error"], ["payload", "error"]])
  if (errorText) {
    return "failed" as const
  }

  if (params.eventName === "PermissionRequest") {
    return "waiting_permission" as const
  }

  if (params.eventName === "PreToolUse") {
    const toolName =
      findFirstString(params.payload, [["tool_name"], ["payload", "tool_name"]]) ?? ""

    if (toolName === "AskUserQuestion" || toolName === "ExitPlanMode") {
      return "waiting_user" as const
    }
  }

  if (params.eventName === "SessionEnd") {
    return "completed" as const
  }

  const reasonText = buildHookReasonText(params.payload)

  if (params.eventName === "Notification") {
    if (reasonText.includes("permission")) {
      return "waiting_permission" as const
    }

    if (reasonText.includes("error") || reasonText.includes("fail") || reasonText.includes("denied")) {
      return "failed" as const
    }

    if (inferWaitingUserFromReason(reasonText)) {
      return "waiting_user" as const
    }

    return "running" as const
  }

  if (params.eventName === "Stop") {
    if (reasonText.includes("permission")) {
      return "waiting_permission" as const
    }

    if (
      reasonText.includes("error") ||
      reasonText.includes("fail") ||
      reasonText.includes("denied")
    ) {
      return "failed" as const
    }

    if (inferWaitingUserFromReason(reasonText)) {
      return "waiting_user" as const
    }

    return "completed" as const
  }

  return "running" as const
}

function inferLaunchContext(params: {
  provider: SessionProvider
  payload: Record<string, unknown>
}) {
  const terminalProgram = (process.env.TERM_PROGRAM ?? "").trim().toLowerCase()
  const hasTerminalSession =
    Boolean(process.env.TERM_SESSION_ID) || Boolean(process.env.TERM_PROGRAM)

  if (
    terminalProgram === "ghostty" ||
    Boolean(process.env.GHOSTTY_RESOURCES_DIR) ||
    Boolean(process.env.GHOSTTY_BIN_DIR)
  ) {
    return {
      launchMode: "cli" as const,
      hostAppId: "ghostty" as const,
      hostAppLabel: "Ghostty",
      hostAppExact: true
    }
  }

  if (
    terminalProgram === "warpterminal" ||
    terminalProgram === "warp" ||
    Boolean(process.env.WARP_SESSION_ID)
  ) {
    return {
      launchMode: "cli" as const,
      hostAppId: "warp" as const,
      hostAppLabel: "Warp",
      hostAppExact: true
    }
  }

  if (terminalProgram === "apple_terminal" || Boolean(process.env.TERM_SESSION_ID)) {
    return {
      launchMode: "cli" as const,
      hostAppId: "terminal" as const,
      hostAppLabel: "Terminal",
      hostAppExact: true
    }
  }

  const sourceHint = (
    findFirstString(params.payload, [
      ["source"],
      ["originator"],
      ["payload", "source"],
      ["payload", "originator"],
      ["session_start_source"],
      ["payload", "session_start_source"]
    ]) ?? ""
  ).toLowerCase()

  if (
    params.provider === "codex" &&
    (sourceHint.includes("desktop") ||
      sourceHint.includes("codex.app") ||
      sourceHint.includes("vscode"))
  ) {
    return {
      launchMode: "app" as const,
      hostAppId: "codex-app" as const,
      hostAppLabel: "Codex.app",
      hostAppExact: true
    }
  }

  if (params.provider === "claude") {
    return {
      launchMode: "cli" as const,
      hostAppId: null,
      hostAppLabel: hasTerminalSession ? "Terminal" : null,
      hostAppExact: false
    }
  }

  return {
    launchMode: hasTerminalSession ? ("cli" as const) : ("app" as const),
    hostAppId: null,
    hostAppLabel: null,
    hostAppExact: false
  }
}

function buildHookPreviews(params: {
  eventName: string
  payload: Record<string, unknown>
}) {
  const lastUserPreview =
    params.eventName === "UserPromptSubmit"
      ? normalizeTextPreview(
          findFirstString(params.payload, [
            ["prompt"],
            ["text"],
            ["message"],
            ["payload", "prompt"],
            ["payload", "text"],
            ["payload", "message"]
          ])
        )
      : null

  const assistantPreviewCandidate = normalizeTextPreview(
    findFirstString(params.payload, [
      ["last_assistant_message"],
      ["assistant_message"],
      ["summary"],
      ["payload", "last_assistant_message"],
      ["payload", "assistant_message"],
      ["payload", "summary"]
    ])
  )

  return {
    lastUserPreview,
    lastAssistantPreview: assistantPreviewCandidate,
    assistantPreviewKind: assistantPreviewCandidate ? ("message" as const) : ("none" as const)
  }
}

function findFirstArray(
  input: Record<string, unknown>,
  candidatePaths: string[][]
) {
  for (const candidatePath of candidatePaths) {
    const value = readPathValue(input, candidatePath)
    if (Array.isArray(value)) {
      return value
    }
  }

  return null
}

function createPendingRequestId(
  sourceSessionId: string,
  eventName: string,
  payload: Record<string, unknown>
) {
  const seed =
    findFirstString(payload, [
      ["tool_use_id"],
      ["toolUseId"],
      ["payload", "tool_use_id"],
      ["payload", "toolUseId"],
      ["request_id"],
      ["requestId"],
      ["tool_name"],
      ["payload", "tool_name"]
    ]) ??
    findFirstString(payload, [["timestamp"], ["event_at"], ["payload", "timestamp"]]) ??
    eventName

  return `${sourceSessionId}:${eventName}:${seed}`
}

function buildDiffPreviewLines(params: {
  removedText: string | null
  addedText: string | null
}) {
  const lines: ControlCenterPendingRequestPreviewLine[] = []
  const removedLines = (params.removedText ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 3)
  const addedLines = (params.addedText ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 4)

  for (const line of removedLines) {
    lines.push({
      kind: "remove",
      text: line
    })
  }

  for (const line of addedLines) {
    lines.push({
      kind: "add",
      text: line
    })
  }

  return lines
}

function buildToolPreviewFromPayload(
  payload: Record<string, unknown>
): ControlCenterPendingRequestPreview | null {
  const toolName =
    findFirstString(payload, [["tool_name"], ["payload", "tool_name"]]) ?? null
  const toolInput = readPathValue(payload, ["tool_input"])
  const normalizedToolInput = toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>)
    : null

  if (!toolName || !normalizedToolInput) {
    return null
  }

  if (toolName === "Bash") {
    const command =
      findFirstString(normalizedToolInput, [["command"], ["cmd"]]) ??
      findFirstString(payload, [["command"], ["payload", "command"]])
    if (command) {
      return {
        type: "command",
        command
      }
    }
  }

  if (toolName === "Edit" || toolName === "Write") {
    const target =
      findFirstString(normalizedToolInput, [["file_path"], ["filePath"]]) ?? null
    const removedText =
      findFirstString(normalizedToolInput, [["old_string"], ["oldString"]]) ?? null
    const addedText =
      findFirstString(normalizedToolInput, [["new_string"], ["newString"], ["content"]]) ??
      null
    const lines = buildDiffPreviewLines({
      removedText,
      addedText
    })

    if (target || lines.length > 0) {
      return {
        type: "diff",
        title: toolName,
        target,
        addedLineCount:
          addedText?.split(/\r?\n/).filter(Boolean).length ?? 0,
        removedLineCount:
          removedText?.split(/\r?\n/).filter(Boolean).length ?? 0,
        lines
      }
    }
  }

  const description =
    findFirstString(normalizedToolInput, [["description"], ["summary"]]) ??
    findFirstString(payload, [["message"], ["title"], ["reason"]])
  if (description) {
    return {
      type: "summary",
      summary: description
    }
  }

  return null
}

function buildClaudePermissionSuggestionAction(
  suggestion: Record<string, unknown>,
  actionIndex: number
): StoredPendingRequestAction | null {
  const type = findFirstString(suggestion, [["type"]]) ?? ""
  const behavior = findFirstString(suggestion, [["behavior"]]) ?? ""
  const destination = findFirstString(suggestion, [["destination"]]) ?? ""

  if (type !== "addRules" || behavior !== "allow" || !destination) {
    return null
  }

  const label =
    destination === "session"
      ? "Allow for session"
      : destination === "userSettings" || destination === "localSettings" || destination === "projectSettings"
        ? "Allow always"
        : "Allow"

  return {
    id: `suggestion-${actionIndex}`,
    label,
    kind: "approve",
    acceleratorHint: null,
    primary: false,
    execution: {
      type: "hook-response",
      hookKind: "permission",
      permissionDecision: "allow",
      updatedPermissions: [suggestion]
    }
  }
}

function buildClaudePermissionRequest(params: {
  provider: SessionProvider
  sourceSessionId: string
  payload: Record<string, unknown>
}): StoredPendingRequest {
  const toolName =
    findFirstString(params.payload, [["tool_name"], ["payload", "tool_name"]]) ?? "Tool"
  const toolInput = readPathValue(params.payload, ["tool_input"])
  const normalizedToolInput = toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>)
    : null
  const prompt =
    findFirstString(params.payload, [["message"], ["title"], ["reason"]]) ??
    (normalizedToolInput
      ? findFirstString(normalizedToolInput, [["description"], ["command"], ["file_path"]])
      : null) ??
    `Claude needs permission to run ${toolName}.`
  const suggestionEntries =
    findFirstArray(params.payload, [["permission_suggestions"], ["payload", "permission_suggestions"]]) ??
    []
  const suggestionActions = suggestionEntries
    .map((entry, index) =>
      entry && typeof entry === "object"
        ? buildClaudePermissionSuggestionAction(entry as Record<string, unknown>, index)
        : null
    )
    .filter((action): action is StoredPendingRequestAction => action !== null)

  const baseActions: StoredPendingRequestAction[] = [
    {
      id: "deny",
      label: "Deny",
      kind: "reject",
      acceleratorHint: null,
      primary: false,
      execution: {
        type: "hook-response",
        hookKind: "permission",
        permissionDecision: "deny"
      }
    },
    {
      id: "allow",
      label: "Allow",
      kind: "approve",
      acceleratorHint: null,
      primary: true,
      execution: {
        type: "hook-response",
        hookKind: "permission",
        permissionDecision: "allow"
      }
    }
  ]

  return {
    requestId: createPendingRequestId(
      params.sourceSessionId,
      "PermissionRequest",
      params.payload
    ),
    provider: params.provider,
    type: "approval_request" as const,
    title: "Permission Request",
    prompt: normalizeTextPreview(prompt) ?? `Claude needs permission to continue.`,
    actions: [...baseActions, ...suggestionActions],
    preview: buildToolPreviewFromPayload(params.payload),
    actionability: "inline" as ControlCenterPendingRequestActionability
  }
}

function buildClaudeAskUserQuestionRequest(params: {
  provider: SessionProvider
  sourceSessionId: string
  payload: Record<string, unknown>
}): StoredPendingRequest | null {
  const toolInput = readPathValue(params.payload, ["tool_input"])
  const normalizedToolInput = toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>)
    : null
  const questions = normalizedToolInput
    ? findFirstArray(normalizedToolInput, [["questions"]])
    : null

  if (!normalizedToolInput || !questions || questions.length !== 1) {
    return null
  }

  const questionEntry = questions[0]
  if (!questionEntry || typeof questionEntry !== "object") {
    return null
  }

  const normalizedQuestion = questionEntry as Record<string, unknown>
  const questionText = findFirstString(normalizedQuestion, [["question"]]) ?? null
  const header = findFirstString(normalizedQuestion, [["header"]]) ?? null
  const multiSelect = Boolean(readPathValue(normalizedQuestion, ["multiSelect"]))
  const options = findFirstArray(normalizedQuestion, [["options"]]) ?? []

  if (!questionText || multiSelect || options.length === 0) {
    return {
      requestId: createPendingRequestId(params.sourceSessionId, "AskUserQuestion", params.payload),
      provider: params.provider,
      type: "choice_request" as const,
      title: header ?? "Claude asks",
      prompt: normalizeTextPreview(questionText ?? "Claude is waiting for input.") ?? "Claude is waiting for input.",
      actions: [],
      preview: null,
      actionability: "open-only" as ControlCenterPendingRequestActionability
    }
  }

  const normalizedActions: StoredPendingRequestAction[] = []
  for (const [index, option] of options.entries()) {
      if (!option || typeof option !== "object") {
        continue
      }

      const normalizedOption = option as Record<string, unknown>
      const label = findFirstString(normalizedOption, [["label"], ["value"], ["title"]])
      if (!label) {
        continue
      }

      normalizedActions.push({
        id: `option-${index + 1}`,
        label,
        kind: "choice" as const,
        acceleratorHint: `${index + 1}`,
        primary: index === 0,
        execution: {
          type: "hook-response" as const,
          hookKind: "pretool" as const,
          permissionDecision: "allow" as const,
          updatedInput: {
            ...normalizedToolInput,
            answers: {
              [questionText]: label
            }
          }
        }
      })
  }

  return {
    requestId: createPendingRequestId(params.sourceSessionId, "AskUserQuestion", params.payload),
    provider: params.provider,
    type: "choice_request" as const,
    title: header ?? "Claude asks",
    prompt: normalizeTextPreview(questionText) ?? questionText,
    actions: normalizedActions,
    preview: null,
    actionability:
      normalizedActions.length > 0 ? ("inline" as const) : ("open-only" as const)
  }
}

function buildClaudeExitPlanModeRequest(params: {
  provider: SessionProvider
  sourceSessionId: string
  payload: Record<string, unknown>
}): StoredPendingRequest {
  const toolInput = readPathValue(params.payload, ["tool_input"])
  const normalizedToolInput = toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>)
    : null
  const planText =
    normalizedToolInput
      ? findFirstString(normalizedToolInput, [["plan"]])
      : null

  const actions: StoredPendingRequestAction[] = [
    {
      id: "continue",
      label: "Continue",
      kind: "continue",
      acceleratorHint: null,
      primary: true,
      execution: {
        type: "hook-response",
        hookKind: "pretool",
        permissionDecision: "allow",
        updatedInput: normalizedToolInput ?? {}
      }
    }
  ]

  return {
    requestId: createPendingRequestId(params.sourceSessionId, "ExitPlanMode", params.payload),
    provider: params.provider,
    type: "continue_request" as const,
    title: "Claude asks",
    prompt: "Move forward with this plan?",
    actions,
    preview: planText
      ? {
          type: "summary",
          summary: normalizeTextPreview(planText) ?? planText
        }
      : null,
    actionability: "inline" as const
  }
}

function buildGenericChoiceRequest(params: {
  provider: SessionProvider
  sourceSessionId: string
  eventName: string
  payload: Record<string, unknown>
}): StoredPendingRequest | null {
  const prompt =
    findFirstString(params.payload, [
      ["question"],
      ["prompt"],
      ["message"],
      ["title"],
      ["payload", "question"],
      ["payload", "prompt"],
      ["payload", "message"],
      ["payload", "title"]
    ]) ?? null
  const options =
    findFirstArray(params.payload, [["options"], ["choices"], ["actions"], ["payload", "options"]]) ??
    []

  if (!prompt || options.length === 0) {
    return null
  }

  const actions: StoredPendingRequestAction[] = []
  for (const [index, option] of options.entries()) {
      if (typeof option === "string") {
        actions.push({
          id: `option-${index + 1}`,
          label: option,
          kind: "choice" as const,
          acceleratorHint: `${index + 1}`,
          primary: index === 0,
          execution: {
            type: "open-only" as const
          }
        })
        continue
      }

      if (!option || typeof option !== "object") {
        continue
      }

      const normalizedOption = option as Record<string, unknown>
      const label =
        findFirstString(normalizedOption, [["label"], ["title"], ["value"], ["name"]]) ??
        null
      if (!label) {
        continue
      }

      actions.push({
        id: `option-${index + 1}`,
        label,
        kind: "choice" as const,
        acceleratorHint: `${index + 1}`,
        primary: index === 0,
        execution: {
          type: "open-only" as const
        }
      })
  }

  return {
    requestId: createPendingRequestId(params.sourceSessionId, params.eventName, params.payload),
    provider: params.provider,
    type: "choice_request" as const,
    title: params.provider === "codex" ? "Codex asks" : "Claude asks",
    prompt: normalizeTextPreview(prompt) ?? prompt,
    actions,
    preview: null,
    actionability: "open-only" as const
  }
}

function buildPendingRequestFromHook(params: {
  provider: SessionProvider
  sourceSessionId: string
  eventName: string
  payload: Record<string, unknown>
}): StoredPendingRequest | null {
  if (params.provider === "claude" && params.eventName === "PermissionRequest") {
    return buildClaudePermissionRequest(params)
  }

  if (params.provider === "claude" && params.eventName === "PreToolUse") {
    const toolName =
      findFirstString(params.payload, [["tool_name"], ["payload", "tool_name"]]) ?? ""
    if (toolName === "AskUserQuestion") {
      return buildClaudeAskUserQuestionRequest(params)
    }
    if (toolName === "ExitPlanMode") {
      return buildClaudeExitPlanModeRequest(params)
    }
  }

  if (
    params.eventName === "Notification" &&
    findFirstString(params.payload, [["notification_type"], ["payload", "notification_type"]]) === "elicitation_dialog"
  ) {
    return buildGenericChoiceRequest(params)
  }

  if (params.eventName === "Notification" || params.eventName === "Stop") {
    return buildGenericChoiceRequest(params)
  }

  return null
}

export function buildNormalizedHookEvent(params: {
  provider: SessionProvider
  eventName: string
  payload: Record<string, unknown>
}): NormalizedLiveHookEvent {
  const sourceSessionId =
    findFirstString(params.payload, [
      ["session_id"],
      ["sessionId"],
      ["payload", "session_id"],
      ["payload", "sessionId"],
      ["session", "id"],
      ["payload", "session", "id"]
    ]) ?? ""

  if (!sourceSessionId) {
    throw new Error(`Unable to determine session id for ${params.provider} hook event.`)
  }

  const launchContext = inferLaunchContext({
    provider: params.provider,
    payload: params.payload
  })
  const previews = buildHookPreviews({
    eventName: params.eventName,
    payload: params.payload
  })
  const eventAt =
    findFirstString(params.payload, [
      ["timestamp"],
      ["event_at"],
      ["payload", "timestamp"],
      ["payload", "event_at"]
    ]) ?? new Date().toISOString()
  const pendingRequest = buildPendingRequestFromHook({
    provider: params.provider,
    sourceSessionId,
    eventName: params.eventName,
    payload: params.payload
  })

  return {
    id: createLiveThreadId(params.provider, sourceSessionId),
    provider: params.provider,
    sourceSessionId,
    eventName: params.eventName,
    eventAt,
    threadName:
      normalizeTextPreview(
        findFirstString(params.payload, [
          ["thread_name"],
          ["threadName"],
          ["title"],
          ["summary"],
          ["payload", "thread_name"],
          ["payload", "threadName"],
          ["payload", "title"],
          ["payload", "summary"]
        ])
      ) ?? null,
    projectPath:
      findFirstString(params.payload, [
        ["cwd"],
        ["project_path"],
        ["projectPath"],
        ["working_directory"],
        ["payload", "cwd"],
        ["payload", "project_path"],
        ["payload", "projectPath"]
      ]) ?? null,
    transcriptPath:
      findFirstString(params.payload, [
        ["transcript_path"],
        ["transcriptPath"],
        ["codex_transcript_path"],
        ["fullPath"],
        ["full_path"],
        ["payload", "transcript_path"],
        ["payload", "transcriptPath"],
        ["payload", "codex_transcript_path"],
        ["payload", "fullPath"]
      ]) ?? null,
    status: classifyLiveThreadStatusFromHook({
      eventName: params.eventName,
      payload: params.payload
    }),
    lastUserPreview: previews.lastUserPreview,
    lastAssistantPreview: previews.lastAssistantPreview,
    assistantPreviewKind: previews.assistantPreviewKind,
    launchMode: launchContext.launchMode,
    hostAppLabel: launchContext.hostAppLabel,
    hostAppExact: launchContext.hostAppExact,
    pendingRequest,
    hostAppId: launchContext.hostAppId
  }
}

function buildPreviewSession(record: StoredLiveThreadRecord): SessionIndexEntry {
  return {
    id: record.id,
    sourceSessionId: record.sourceSessionId,
    provider: record.provider,
    archived: false,
    threadName: record.threadName,
    createdAt: record.lastEventAt,
    updatedAt: record.lastEventAt,
    projectPath: record.projectPath
  }
}

function chooseAssistantPreview(params: {
  status: LiveThreadStatus
  lastAssistantMessage: string | null
  lastThoughtPreview: string | null
}) {
  if (params.status === "running" && params.lastThoughtPreview) {
    return {
      lastAssistantPreview: params.lastThoughtPreview,
      assistantPreviewKind: "thinking" as const
    }
  }

  if (params.lastAssistantMessage) {
    return {
      lastAssistantPreview: params.lastAssistantMessage,
      assistantPreviewKind: "message" as const
    }
  }

  if (params.lastThoughtPreview) {
    return {
      lastAssistantPreview: params.lastThoughtPreview,
      assistantPreviewKind: "thinking" as const
    }
  }

  return {
    lastAssistantPreview: null,
    assistantPreviewKind: "none" as const
  }
}

async function readTranscriptPreview(record: StoredLiveThreadRecord) {
  if (!record.transcriptPath || !fs.existsSync(record.transcriptPath)) {
    return null
  }

  const sessionContent = await fsPromises.readFile(record.transcriptPath, "utf8")
  const transcript = buildConversationTranscript({
    session: buildPreviewSession(record),
    sessionContent,
    sessionPath: record.transcriptPath,
    options: {
      includeCommentary: true,
      includeDiffs: false
    }
  })

  let lastUserPreview: string | null = null
  let lastAssistantMessage: string | null = null
  let lastThoughtPreview: string | null = null

  for (const entry of transcript.entries) {
    if (entry.kind === "message" && entry.role === "user") {
      lastUserPreview = normalizeTextPreview(entry.bodyMarkdown)
      continue
    }

    if (entry.kind === "thought_chain") {
      lastThoughtPreview = normalizeTextPreview(
        entry.messages.at(-1)?.bodyMarkdown ?? null
      )
      continue
    }

    if (entry.kind === "message" && entry.role === "assistant") {
      lastAssistantMessage = normalizeTextPreview(entry.bodyMarkdown)
    }
  }

  const assistantPreview = chooseAssistantPreview({
    status: record.status,
    lastAssistantMessage,
    lastThoughtPreview
  })

  const lastEntryTimestamp = transcript.entries.at(-1)?.timestamp ?? null
  const sessionClient = transcript.sessionClient ?? "unknown"
  const nextLaunchMode =
    record.provider === "claude"
      ? ("cli" as const)
      : sessionClient === "desktop"
        ? ("app" as const)
        : sessionClient === "cli"
          ? ("cli" as const)
          : record.launchMode

  const nextHostContext =
    record.provider === "codex" && sessionClient === "desktop"
      ? {
          hostAppId: "codex-app" as const,
          hostAppLabel: "Codex.app",
          hostAppExact: true
        }
      : nextLaunchMode === "cli" && record.hostAppId === "codex-app"
        ? {
            hostAppId: null,
            hostAppLabel: null,
            hostAppExact: false
          }
        : {
            hostAppId: record.hostAppId,
            hostAppLabel: record.hostAppLabel,
            hostAppExact: record.hostAppExact
          }

  return {
    threadName:
      isFallbackThreadName(record.provider, record.threadName) && lastUserPreview
        ? lastUserPreview
        : record.threadName,
    projectPath:
      transcript.projectPath ?? transcript.sessionCwd ?? record.projectPath,
    lastUserPreview: lastUserPreview ?? record.lastUserPreview,
    lastAssistantPreview: assistantPreview.lastAssistantPreview,
    assistantPreviewKind: assistantPreview.assistantPreviewKind,
    lastEventAt: lastEntryTimestamp ?? record.lastEventAt,
    launchMode: nextLaunchMode,
    hostAppId: nextHostContext.hostAppId,
    hostAppLabel: nextHostContext.hostAppLabel,
    hostAppExact: nextHostContext.hostAppExact
  }
}

function shouldClearPendingRequest(event: NormalizedLiveHookEvent) {
  return (
    event.eventName === "UserPromptSubmit" ||
    (event.status !== "waiting_permission" && event.status !== "waiting_user")
  )
}

function mergePendingRequest(params: {
  existing: StoredLiveThreadRecord | null
  event: NormalizedLiveHookEvent
}) {
  if (params.event.pendingRequest) {
    return params.event.pendingRequest
  }

  if (shouldClearPendingRequest(params.event)) {
    return null
  }

  return params.existing?.pendingRequest ?? null
}

function createHookResolutionEnvelope(
  action: StoredPendingRequestAction
): HookResolutionEnvelope {
  if (action.execution.type !== "hook-response") {
    return {
      type: "delegate-to-provider"
    }
  }

  const baseOutput =
    action.execution.hookKind === "permission"
      ? {
          hookEventName: "PermissionRequest",
          permissionDecision: action.execution.permissionDecision
        }
      : {
          hookEventName: "PreToolUse",
          permissionDecision: action.execution.permissionDecision
        }

  const hookSpecificOutput: Record<string, unknown> = {
    ...baseOutput
  }

  if (action.execution.updatedInput) {
    hookSpecificOutput.updatedInput = action.execution.updatedInput
  }

  if (action.execution.updatedPermissions) {
    hookSpecificOutput.updatedPermissions = action.execution.updatedPermissions
  }

  return {
    type: "hook-response",
    hookSpecificOutput
  }
}

function shouldAwaitHookResolution(event: NormalizedLiveHookEvent) {
  return (
    event.provider === "claude" &&
    event.pendingRequest?.actionability === "inline" &&
    (event.eventName === "PermissionRequest" || event.eventName === "PreToolUse")
  )
}

function shouldPlaySound(previous: StoredLiveThreadRecord | null, next: StoredLiveThreadRecord) {
  const soundableStatuses = new Set<LiveThreadStatus>([
    "waiting_user",
    "waiting_permission",
    "completed"
  ])

  if (!soundableStatuses.has(next.status)) {
    return false
  }

  if (previous?.status === next.status) {
    return false
  }

  const now = Date.now()
  const lastSoundAt = next.lastSoundAt ? Date.parse(next.lastSoundAt) : Number.NaN
  if (!Number.isNaN(lastSoundAt) && now - lastSoundAt < THREAD_SOUND_DEBOUNCE_MS) {
    return false
  }

  return true
}

async function readJsonLines<T>(filePath: string) {
  try {
    const content = await fsPromises.readFile(filePath, "utf8")
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as T)
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [] as T[]
    }

    throw error
  }
}

async function readPersistedRecords(recordsPath: string) {
  try {
    const parsed = JSON.parse(await fsPromises.readFile(recordsPath, "utf8")) as PersistedControlCenterState
    return Array.isArray(parsed.records) ? parsed.records : []
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [] as StoredLiveThreadRecord[]
    }

    throw error
  }
}

export function buildLiveHookCommandString(params: {
  bridgeCommand: HookCommandConfig
  provider: SessionProvider
  eventName: SupportedHookEvent
}) {
  const segments = [
    params.bridgeCommand.command,
    ...params.bridgeCommand.args,
    CONTROL_CENTER_HOOK_MODE_ARG,
    "--provider",
    params.provider,
    "--event",
    params.eventName
  ]

  return segments.map(shellEscape).join(" ")
}

export function isHandoffLiveHookCommand(command: string) {
  return command.includes(LIVE_HOOK_COMMAND_MARKER)
}

export async function runControlCenterHookBridge(params: {
  dataDir: string
  provider: SessionProvider
  eventName: string
}) {
  const stdinChunks: Buffer[] = []

  for await (const chunk of process.stdin) {
    stdinChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }

  const rawInput = Buffer.concat(stdinChunks).toString("utf8").trim()
  const payload =
    rawInput.length > 0
      ? (JSON.parse(rawInput) as Record<string, unknown>)
      : {}
  const normalizedEvent = buildNormalizedHookEvent({
    provider: params.provider,
    eventName: params.eventName,
    payload
  })
  const paths = getControlCenterStatePaths(params.dataDir)
  const awaitResolution = shouldAwaitHookResolution(normalizedEvent)

  await fsPromises.mkdir(paths.rootDir, { recursive: true })

  await new Promise<void>(resolve => {
    const socket = net.createConnection(paths.socketPath, () => {
      const message: HookSocketClientMessage = {
        type: "event",
        awaitResolution,
        event: normalizedEvent
      }
      socket.write(`${JSON.stringify(message)}\n`)

      if (!awaitResolution) {
        socket.end()
        resolve()
      }
    })

    let buffer = ""
    socket.on("error", async () => {
      if (awaitResolution) {
        resolve()
        return
      }

      await fsPromises.appendFile(
        paths.spoolPath,
        `${JSON.stringify(normalizedEvent)}\n`,
        "utf8"
      )
      resolve()
    })

    if (awaitResolution) {
      socket.setEncoding("utf8")
      socket.on("data", chunk => {
        buffer += chunk
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) {
            continue
          }

          try {
            const parsed = JSON.parse(trimmed) as HookSocketServerMessage
            if (parsed.type !== "resolve") {
              continue
            }

            if (parsed.resolution.type === "hook-response") {
              process.stdout.write(
                `${JSON.stringify({
                  hookSpecificOutput: parsed.resolution.hookSpecificOutput
                })}\n`
              )
            }

            socket.end()
            resolve()
            return
          } catch {
            continue
          }
        }
      })
    }
  })
}

export function createControlCenterService(
  options: ControlCenterServiceOptions
): ControlCenterService {
  const events = new EventEmitter()
  const paths = getControlCenterStatePaths(options.dataDir)
  const sessionInfoById = new Map<string, SessionListItem>()
  const onPlaySound =
    options.onPlaySound ??
    (async () => {
      await execFileAsync("afplay", [DEFAULT_SOUND_PATH])
    })

  let records = new Map<string, StoredLiveThreadRecord>()
  let socketServer: net.Server | null = null
  let spoolWatcher: ReturnType<typeof chokidar.watch> | null = null
  let transcriptWatcher: ReturnType<typeof chokidar.watch> | null = null
  let lastGlobalSoundAt = 0
  const pendingHookResolutions = new Map<
    string,
    {
      resolve(message: HookSocketServerMessage): void
      threadId: string
    }
  >()

  async function persistRecords() {
    await fsPromises.mkdir(paths.rootDir, { recursive: true })
    const payload: PersistedControlCenterState = {
      version: 1,
      records: [...records.values()]
    }
    await fsPromises.writeFile(
      paths.recordsPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8"
    )
  }

  function emitStateChanged(threadId: string | null) {
    events.emit("state-changed", {
      at: new Date().toISOString(),
      reason: "records-changed",
      threadId
    } satisfies ControlCenterStateChangeEvent)
  }

  function clearPendingHookResolution(requestId: string) {
    pendingHookResolutions.delete(requestId)
  }

  function resolvePendingHookRequest(
    requestId: string,
    message: HookSocketServerMessage
  ) {
    const pending = pendingHookResolutions.get(requestId)
    if (!pending) {
      return false
    }

    clearPendingHookResolution(requestId)
    pending.resolve(message)
    return true
  }

  async function maybePlaySound(previous: StoredLiveThreadRecord | null, next: StoredLiveThreadRecord) {
    if (!shouldPlaySound(previous, next)) {
      return next
    }

    const now = Date.now()
    if (now - lastGlobalSoundAt < GLOBAL_SOUND_DEBOUNCE_MS) {
      return next
    }

    lastGlobalSoundAt = now

    try {
      await onPlaySound(serializeRecord(next))
      return {
        ...next,
        lastSoundAt: new Date(now).toISOString(),
        lastSoundStatus: next.status
      }
    } catch {
      return next
    }
  }

  async function buildSnapshot() {
    return {
      records: sortLiveThreadRecords(
        [...records.values()]
          .filter(record => !record.dismissedAt)
          .map(serializeRecord)
      )
    } satisfies ControlCenterSnapshot
  }

  async function refreshTranscriptWatcher() {
    const watchedPaths = [...records.values()]
      .filter(record => !record.dismissedAt && record.transcriptPath)
      .map(record => record.transcriptPath as string)

    if (transcriptWatcher) {
      await transcriptWatcher.close()
      transcriptWatcher = null
    }

    if (watchedPaths.length === 0) {
      return
    }

    transcriptWatcher = chokidar.watch(watchedPaths, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 25
      }
    })

    transcriptWatcher.on("all", (_eventName, changedPath) => {
      const targetRecord = [...records.values()].find(
        record => record.transcriptPath === changedPath
      )

      if (!targetRecord) {
        return
      }

      void refreshRecordFromTranscript(targetRecord.id)
    })
  }

  async function writeUpdatedRecord(record: StoredLiveThreadRecord, previous: StoredLiveThreadRecord | null) {
    const soundAwareRecord = await maybePlaySound(previous, record)
    records.set(soundAwareRecord.id, soundAwareRecord)
    await persistRecords()
    await refreshTranscriptWatcher()
    emitStateChanged(soundAwareRecord.id)
  }

  async function refreshRecordFromTranscript(id: string) {
    const currentRecord = records.get(id)
    if (!currentRecord) {
      return
    }

    const previewUpdate = await readTranscriptPreview(currentRecord)
    if (!previewUpdate) {
      return
    }

    const nextRecord: StoredLiveThreadRecord = {
      ...currentRecord,
      threadName: previewUpdate.threadName,
      projectPath: previewUpdate.projectPath,
      lastUserPreview: previewUpdate.lastUserPreview,
      lastAssistantPreview: previewUpdate.lastAssistantPreview,
      assistantPreviewKind: previewUpdate.assistantPreviewKind,
      lastEventAt:
        previewUpdate.lastEventAt.localeCompare(currentRecord.lastEventAt) > 0
          ? previewUpdate.lastEventAt
          : currentRecord.lastEventAt,
      launchMode: previewUpdate.launchMode,
      hostAppId: previewUpdate.hostAppId,
      hostAppLabel: previewUpdate.hostAppLabel,
      hostAppExact: previewUpdate.hostAppExact
    }

    records.set(id, nextRecord)
    await persistRecords()
    emitStateChanged(id)
  }

  async function reconcileOneSession(session: SessionListItem) {
    const currentRecord = records.get(session.id)
    if (!currentRecord) {
      return
    }

    const nextRecord: StoredLiveThreadRecord = {
      ...currentRecord,
      threadName:
        isFallbackThreadName(currentRecord.provider, currentRecord.threadName) ||
        currentRecord.threadName !== session.threadName
          ? session.threadName
          : currentRecord.threadName,
      projectPath: session.projectPath ?? currentRecord.projectPath,
      transcriptPath: session.sessionPath ?? currentRecord.transcriptPath
    }

    records.set(session.id, nextRecord)
    await refreshRecordFromTranscript(session.id).catch(() => undefined)
  }

  async function consumeSpool() {
    await fsPromises.mkdir(paths.rootDir, { recursive: true })
    const processingPath = `${paths.spoolPath}.processing`

    try {
      await fsPromises.rename(paths.spoolPath, processingPath)
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return
      }

      throw error
    }

    const queuedEvents = await readJsonLines<NormalizedLiveHookEvent>(processingPath)
    await fsPromises.rm(processingPath, { force: true })

    for (const event of queuedEvents) {
      await ingestNormalizedHookEvent(event)
    }
  }

  async function ingestNormalizedHookEvent(event: NormalizedLiveHookEvent) {
    const existing = records.get(event.id) ?? null
    const session = sessionInfoById.get(event.id) ?? null
    const nextPendingRequest = mergePendingRequest({
      existing,
      event
    })

    if (
      existing?.pendingRequest?.requestId &&
      existing.pendingRequest.requestId !== nextPendingRequest?.requestId
    ) {
      clearPendingHookResolution(existing.pendingRequest.requestId)
    }

    const nextRecordBase: StoredLiveThreadRecord = {
      id: event.id,
      provider: event.provider,
      sourceSessionId: event.sourceSessionId,
      threadName:
        event.threadName ??
        session?.threadName ??
        existing?.threadName ??
        buildDefaultThreadName(event.provider),
      projectPath: event.projectPath ?? session?.projectPath ?? existing?.projectPath ?? null,
      transcriptPath:
        event.transcriptPath ?? session?.sessionPath ?? existing?.transcriptPath ?? null,
      status: event.status,
      lastEventAt:
        existing && existing.lastEventAt.localeCompare(event.eventAt) > 0
          ? existing.lastEventAt
          : event.eventAt,
      lastUserPreview:
        event.lastUserPreview ?? existing?.lastUserPreview ?? null,
      lastAssistantPreview:
        event.lastAssistantPreview ?? existing?.lastAssistantPreview ?? null,
      assistantPreviewKind:
        event.lastAssistantPreview || event.assistantPreviewKind !== "none"
          ? event.assistantPreviewKind
          : existing?.assistantPreviewKind ?? "none",
      launchMode: event.launchMode,
      hostAppId: event.hostAppId,
      hostAppLabel: event.hostAppLabel,
      hostAppExact: event.hostAppExact,
      pendingRequest: nextPendingRequest,
      acknowledgedAt: null,
      dismissedAt: null,
      lastSoundStatus: existing?.lastSoundStatus ?? null,
      lastSoundAt: existing?.lastSoundAt ?? null
    }

    const nextRecord = await maybePlaySound(existing, nextRecordBase)
    records.set(event.id, nextRecord)
    await persistRecords()
    await refreshTranscriptWatcher()
    emitStateChanged(event.id)

    if (nextRecord.transcriptPath) {
      await refreshRecordFromTranscript(nextRecord.id).catch(() => undefined)
    }
  }

  return {
    async getSnapshot() {
      return buildSnapshot()
    },

    async getRecord(id) {
      return records.get(id) ?? null
    },

    async acknowledge(id) {
      const currentRecord = records.get(id)
      if (!currentRecord) {
        return null
      }

      const nextRecord = {
        ...currentRecord,
        acknowledgedAt: new Date().toISOString()
      }

      records.set(id, nextRecord)
      await persistRecords()
      emitStateChanged(id)
      return nextRecord
    },

    async delegatePendingRequest(id) {
      const currentRecord = records.get(id)
      if (!currentRecord?.pendingRequest) {
        return currentRecord ?? null
      }

      resolvePendingHookRequest(currentRecord.pendingRequest.requestId, {
        type: "resolve",
        resolution: {
          type: "delegate-to-provider"
        }
      })

      const nextRecord: StoredLiveThreadRecord = {
        ...currentRecord,
        pendingRequest: {
          ...currentRecord.pendingRequest,
          actionability: "open-only"
        }
      }

      records.set(id, nextRecord)
      await persistRecords()
      emitStateChanged(id)
      return nextRecord
    },

    async performAction(threadId, requestId, actionId) {
      const currentRecord = records.get(threadId)
      if (!currentRecord || !currentRecord.pendingRequest) {
        throw new Error("No pending request is available for this thread.")
      }

      if (currentRecord.pendingRequest.requestId !== requestId) {
        throw new Error("This request is no longer current.")
      }

      const action = currentRecord.pendingRequest.actions.find(
        candidate => candidate.id === actionId
      )
      if (!action) {
        throw new Error("This action is no longer available.")
      }

      if (currentRecord.pendingRequest.actionability === "open-only") {
        return {
          snapshot: await buildSnapshot(),
          fallbackMessage: "Open this request in the source app to respond."
        }
      }

      if (action.execution.type !== "hook-response") {
        return {
          snapshot: await buildSnapshot(),
          fallbackMessage: "Open this request in the source app to respond."
        }
      }

      const resolved = resolvePendingHookRequest(requestId, {
        type: "resolve",
        resolution: createHookResolutionEnvelope(action)
      })

      if (!resolved) {
        return {
          snapshot: await buildSnapshot(),
          fallbackMessage: "This request has already moved back to the source app."
        }
      }

      const nextRecord: StoredLiveThreadRecord = {
        ...currentRecord,
        status:
          currentRecord.status === "waiting_permission" ||
          currentRecord.status === "waiting_user"
            ? "running"
            : currentRecord.status,
        pendingRequest: null,
        lastEventAt: new Date().toISOString()
      }

      records.set(threadId, nextRecord)
      await persistRecords()
      emitStateChanged(threadId)

      return {
        snapshot: await buildSnapshot(),
        fallbackMessage: null
      }
    },

    async dismiss(id) {
      const currentRecord = records.get(id)
      if (!currentRecord) {
        return buildSnapshot()
      }

      records.set(id, {
        ...currentRecord,
        dismissedAt: new Date().toISOString()
      })
      await persistRecords()
      emitStateChanged(id)
      return buildSnapshot()
    },

    async dismissCompleted() {
      const dismissedAt = new Date().toISOString()

      for (const [id, record] of records.entries()) {
        if (record.status !== "completed" && record.status !== "failed") {
          continue
        }

        records.set(id, {
          ...record,
          dismissedAt
        })
      }

      await persistRecords()
      emitStateChanged(null)
      return buildSnapshot()
    },

    async reconcileSessions(sessions) {
      sessions.forEach(session => {
        sessionInfoById.set(session.id, session)
      })

      for (const session of sessions) {
        await reconcileOneSession(session)
      }

      await refreshTranscriptWatcher()
    },

    async ingestHookEvent(event) {
      await ingestNormalizedHookEvent({
        ...event,
        pendingRequest: null,
        hostAppId: null
      })
    },

    async startWatching() {
      await fsPromises.mkdir(paths.rootDir, { recursive: true })
      const persistedRecords = await readPersistedRecords(paths.recordsPath)
      records = new Map(persistedRecords.map(record => [record.id, record]))

      await consumeSpool()
      await refreshTranscriptWatcher()

      if (!spoolWatcher) {
        spoolWatcher = chokidar.watch(paths.spoolPath, {
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: 100,
            pollInterval: 25
          }
        })
        spoolWatcher.on("all", () => {
          void consumeSpool()
        })
      }

      if (!socketServer) {
        await fsPromises.rm(paths.socketPath, { force: true })
        socketServer = net.createServer(socket => {
          let buffer = ""
          const connectionRequestIds = new Set<string>()
          socket.setEncoding("utf8")
          socket.on("close", () => {
            for (const requestId of connectionRequestIds) {
              pendingHookResolutions.delete(requestId)
            }
          })
          socket.on("data", chunk => {
            buffer += chunk
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) {
                continue
              }

              try {
                const parsed = JSON.parse(trimmed) as HookSocketClientMessage | NormalizedLiveHookEvent
                if (
                  parsed &&
                  typeof parsed === "object" &&
                  "type" in parsed &&
                  parsed.type === "event"
                ) {
                  const message = parsed as HookSocketClientMessage
                  if (message.awaitResolution && message.event.pendingRequest) {
                    connectionRequestIds.add(message.event.pendingRequest.requestId)
                    pendingHookResolutions.set(message.event.pendingRequest.requestId, {
                      threadId: message.event.id,
                      resolve(serverMessage) {
                        socket.write(`${JSON.stringify(serverMessage)}\n`)
                        socket.end()
                      }
                    })
                  }

                  void ingestNormalizedHookEvent(message.event)
                  if (!message.awaitResolution) {
                    const ack: HookSocketServerMessage = {
                      type: "ack"
                    }
                    socket.write(`${JSON.stringify(ack)}\n`)
                  }
                  continue
                }

                void ingestNormalizedHookEvent(parsed as NormalizedLiveHookEvent)
              } catch {
                continue
              }
            }
          })
        })

        await new Promise<void>((resolve, reject) => {
          socketServer?.once("error", reject)
          socketServer?.listen(paths.socketPath, () => {
            socketServer?.off("error", reject)
            resolve()
          })
        })
      }
    },

    onStateChanged(listener) {
      events.on("state-changed", listener)
      return () => {
        events.off("state-changed", listener)
      }
    },

    async dispose() {
      events.removeAllListeners()

      if (spoolWatcher) {
        await spoolWatcher.close()
        spoolWatcher = null
      }

      if (transcriptWatcher) {
        await transcriptWatcher.close()
        transcriptWatcher = null
      }

      if (socketServer) {
        await new Promise<void>(resolve => {
          socketServer?.close(() => resolve())
        })
        socketServer = null
      }

      await fsPromises.rm(paths.socketPath, { force: true }).catch(() => undefined)
    }
  }
}
