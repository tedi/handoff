import type {
  AssistantMessageEntry,
  AssistantThoughtChainEntry,
  ConversationEntry,
  ConversationPatch,
  ConversationTranscript,
  SessionClient,
  SessionIndexEntry,
  TranscriptOptions
} from "./contracts"

const PATCH_FILE_PATTERN = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm
const SCAFFOLD_USER_PREFIXES = [
  "# AGENTS.md instructions for ",
  "<environment_context>"
]
const CLAUDE_HIDDEN_USER_PREFIXES = [
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<system-reminder>"
]

interface MessageRecord {
  id: string
  role: "user" | "assistant"
  text: string
  timestamp: string
  turnId: string | null
  phase: string | null
}

interface PatchRecord {
  patch: string
  timestamp: string
  turnId: string | null
}

interface JsonRecord {
  type?: string
  timestamp?: string
  payload?: Record<string, unknown>
  message?: Record<string, unknown>
  toolUseResult?: Record<string, unknown>
  isMeta?: boolean
  cwd?: string
}

interface ParsedSessionMeta {
  client: SessionClient
  cwd: string | null
}

interface ParsedTranscriptData {
  entries: ConversationEntry[]
  lastAssistantMarkdown: string | null
  hasDiffs: boolean
  sessionMeta: ParsedSessionMeta
}

interface ClaudeToolUseRecord {
  id: string
  name: string
  input: Record<string, unknown>
  timestamp: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function basename(filePath: string) {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isScaffoldUserMessage(text: string) {
  const stripped = text.trimStart()
  return SCAFFOLD_USER_PREFIXES.some(prefix => stripped.startsWith(prefix))
}

function isClaudeHiddenUserText(text: string) {
  const stripped = text.trimStart()
  return CLAUDE_HIDDEN_USER_PREFIXES.some(prefix => stripped.startsWith(prefix))
}

function extractMessageText(payload: Record<string, unknown>) {
  const content = payload.content

  if (typeof content === "string") {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return typeof payload.text === "string" ? payload.text.trim() : ""
  }

  const parts: string[] = []
  for (const item of content) {
    if (!isRecord(item)) {
      continue
    }

    const type = item.type
    const text =
      type === "input_text" || type === "output_text"
        ? item.text
        : type === "text"
          ? (item.text ?? item.content)
          : null

    if (typeof text === "string" && text.trim()) {
      parts.push(text.trim())
    }
  }

  return parts.join("\n\n").trim()
}

function extractClaudeTextContent(message: Record<string, unknown>) {
  const content = message.content

  if (typeof content === "string") {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return ""
  }

  const parts: string[] = []
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text") {
      continue
    }

    const text = item.text
    if (!isNonEmptyString(text)) {
      continue
    }

    const trimmed = text.trim()
    if (!trimmed || isClaudeHiddenUserText(trimmed)) {
      continue
    }

    parts.push(trimmed)
  }

  return parts.join("\n\n").trim()
}

function extractPatchFiles(patch: string) {
  return Array.from(patch.matchAll(PATCH_FILE_PATTERN), match => match[1] ?? "")
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) {
      return index
    }
  }

  return null
}

function attachPatchesToMessages(messages: MessageRecord[], patches: PatchRecord[]) {
  const attachments = new Map<number, PatchRecord[]>()

  for (const patch of patches) {
    const sameTurnAssistants = messages
      .map((message, index) => ({ index, message }))
      .filter(
        entry =>
          entry.message.role === "assistant" && entry.message.turnId === patch.turnId
      )

    if (sameTurnAssistants.length === 0) {
      continue
    }

    const futureFinalAnswer = sameTurnAssistants.find(
      entry =>
        entry.message.timestamp >= patch.timestamp &&
        entry.message.phase === "final_answer"
    )
    const futureAssistant = sameTurnAssistants.find(
      entry => entry.message.timestamp >= patch.timestamp
    )
    const targetIndex =
      futureFinalAnswer?.index ??
      futureAssistant?.index ??
      sameTurnAssistants.at(-1)?.index

    if (targetIndex === undefined) {
      continue
    }

    const existing = attachments.get(targetIndex) ?? []
    existing.push(patch)
    attachments.set(targetIndex, existing)
  }

  return attachments
}

function renderMarkdown(
  entries: ConversationEntry[],
  includeDiffs: boolean,
  includeCommentary: boolean
) {
  const parts: string[] = ["# Transcript"]

  entries.forEach(entry => {
    if (!includeCommentary && entry.kind === "thought_chain") {
      return
    }

    parts.push(`\n## ${entry.role === "assistant" ? "Assistant" : "User"}`)

    if (entry.kind === "thought_chain") {
      parts.push(entry.messages.map(message => message.bodyMarkdown).join("\n\n"))
      return
    }

    parts.push(entry.bodyMarkdown)

    if (!includeDiffs || entry.kind !== "message" || entry.role !== "assistant") {
      return
    }

    if (entry.patches.length === 0) {
      return
    }

    parts.push("\n### Diffs")
    entry.patches.forEach((patch, patchIndex) => {
      parts.push(`\n#### Patch ${patchIndex + 1}`)
      parts.push(`Files: ${patch.files.length > 0 ? patch.files.join(", ") : "unknown files"}`)
      parts.push(`\n\`\`\`diff\n${patch.patch}\n\`\`\``)
    })
  })

  return `${parts.join("\n").trim()}\n`
}

function parseSessionClient(payload: Record<string, unknown>): SessionClient {
  const source = typeof payload.source === "string" ? payload.source : null
  const originator =
    typeof payload.originator === "string" ? payload.originator : null

  if (source === "cli" || originator === "codex_cli_rs") {
    return "cli"
  }

  if (source === "vscode" || originator === "Codex Desktop") {
    return "desktop"
  }

  return "unknown"
}

function extractCodexSessionMeta(lines: string[]) {
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.trim()
    if (!line) {
      continue
    }

    let record: JsonRecord
    try {
      record = JSON.parse(line) as JsonRecord
    } catch {
      continue
    }

    if (record.type !== "session_meta" || !isRecord(record.payload)) {
      continue
    }

    return {
      client: parseSessionClient(record.payload),
      cwd:
        typeof record.payload.cwd === "string" ? record.payload.cwd : null
    } satisfies ParsedSessionMeta
  }

  return {
    client: "unknown",
    cwd: null
  } satisfies ParsedSessionMeta
}

function buildEntriesFromCodexMessages(messages: MessageRecord[], patches: PatchRecord[]) {
  const attachments = attachPatchesToMessages(messages, patches)
  const entries: ConversationEntry[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!

    if (message.role === "user") {
      entries.push({
        id: message.id,
        kind: "message",
        role: "user",
        timestamp: message.timestamp,
        bodyMarkdown: message.text
      })
      continue
    }

    if (message.phase === "commentary") {
      const thoughtMessages = []
      let nextIndex = index

      while (
        nextIndex < messages.length &&
        messages[nextIndex]?.role === "assistant" &&
        messages[nextIndex]?.phase === "commentary"
      ) {
        const currentMessage = messages[nextIndex]!
        thoughtMessages.push({
          id: currentMessage.id,
          bodyMarkdown: currentMessage.text
        })
        nextIndex += 1
      }

      const thoughtChainEntry: AssistantThoughtChainEntry = {
        id: `thought-chain-${message.id}`,
        kind: "thought_chain",
        role: "assistant",
        timestamp: message.timestamp,
        collapsedByDefault: true,
        messageCount: thoughtMessages.length,
        messages: thoughtMessages
      }

      entries.push(thoughtChainEntry)
      index = nextIndex - 1
      continue
    }

    const patchEntries: ConversationPatch[] = (attachments.get(index) ?? []).map(
      (patch, patchIndex) => ({
        id: `${message.id}-patch-${patchIndex + 1}`,
        patch: patch.patch,
        files: extractPatchFiles(patch.patch)
      })
    )

    const assistantEntry: AssistantMessageEntry = {
      id: message.id,
      kind: "message",
      role: "assistant",
      timestamp: message.timestamp,
      bodyMarkdown: message.text,
      patches: patchEntries
    }

    entries.push(assistantEntry)
  }

  return entries
}

function buildCodexTranscriptData(lines: string[]): ParsedTranscriptData {
  const messages: MessageRecord[] = []
  const patches: PatchRecord[] = []
  let currentTurnId: string | null = null

  const sessionMeta = extractCodexSessionMeta(lines)

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.trim()
    if (!line) {
      continue
    }

    let record: JsonRecord
    try {
      record = JSON.parse(line) as JsonRecord
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid JSON on line ${lineIndex + 1}: ${message}`)
    }

    const payload = isRecord(record.payload) ? record.payload : {}
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : ""

    if (record.type === "event_msg" && payload.type === "task_started") {
      currentTurnId =
        typeof payload.turn_id === "string" ? payload.turn_id : null
      continue
    }

    if (record.type !== "response_item") {
      continue
    }

    if (payload.type === "message") {
      const role =
        payload.role === "user" || payload.role === "assistant"
          ? payload.role
          : null
      if (!role) {
        continue
      }

      const text = extractMessageText(payload)
      if (!text) {
        continue
      }

      if (role === "user" && isScaffoldUserMessage(text)) {
        continue
      }

      const phase = typeof payload.phase === "string" ? payload.phase : null

      messages.push({
        id: `message-${messages.length + 1}`,
        role,
        text,
        timestamp,
        turnId: currentTurnId,
        phase
      })
      continue
    }

    if (
      (payload.type === "custom_tool_call" || payload.type === "function_call") &&
      payload.name === "apply_patch"
    ) {
      const patchInput =
        typeof payload.input === "string"
          ? payload.input
          : typeof payload.arguments === "string"
            ? payload.arguments
            : ""

      if (!patchInput) {
        continue
      }

      patches.push({
        patch: patchInput,
        timestamp,
        turnId: currentTurnId
      })
    }
  }

  const entries = buildEntriesFromCodexMessages(messages, patches)

  return {
    entries,
    lastAssistantMarkdown: findLastAssistantMarkdown(entries),
    hasDiffs: patches.length > 0,
    sessionMeta
  }
}

function coerceNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function buildPatchHeader(operation: "add" | "update" | "delete", filePath: string) {
  if (operation === "add") {
    return `*** Add File: ${filePath}`
  }

  if (operation === "delete") {
    return `*** Delete File: ${filePath}`
  }

  return `*** Update File: ${filePath}`
}

function buildStructuredPatchString(params: {
  filePath: string
  operation: "add" | "update" | "delete"
  structuredPatch: unknown
}) {
  const hunks = Array.isArray(params.structuredPatch)
    ? params.structuredPatch.filter(isRecord)
    : []

  const lines = ["*** Begin Patch", buildPatchHeader(params.operation, params.filePath)]

  for (const hunk of hunks) {
    const oldStart = coerceNumber(hunk.oldStart)
    const oldLines = coerceNumber(hunk.oldLines)
    const newStart = coerceNumber(hunk.newStart)
    const newLines = coerceNumber(hunk.newLines)

    if (
      oldStart !== null &&
      oldLines !== null &&
      newStart !== null &&
      newLines !== null
    ) {
      lines.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`)
    } else {
      lines.push("@@")
    }

    const hunkLines = Array.isArray(hunk.lines)
      ? hunk.lines.filter((line): line is string => typeof line === "string")
      : []
    lines.push(...hunkLines)
  }

  lines.push("*** End Patch")
  return lines.join("\n")
}

function buildAddFilePatch(filePath: string, content: string) {
  const lines = ["*** Begin Patch", `*** Add File: ${filePath}`]
  lines.push(...content.split(/\r?\n/).map(line => `+${line}`))
  lines.push("*** End Patch")
  return lines.join("\n")
}

function extractClaudeToolFilePath(
  toolUse?: ClaudeToolUseRecord | null,
  toolUseResult?: Record<string, unknown> | null
) {
  const input = toolUse?.input ?? {}
  const inputFilePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.filePath === "string"
        ? input.filePath
        : typeof input.path === "string"
          ? input.path
          : null

  if (isRecord(toolUseResult) && typeof toolUseResult.filePath === "string") {
    return toolUseResult.filePath
  }

  return inputFilePath
}

function summarizeClaudeToolResult(
  toolUse: ClaudeToolUseRecord,
  toolUseResult: Record<string, unknown> | null
) {
  const description =
    typeof toolUse.input.description === "string"
      ? toolUse.input.description.trim()
      : ""

  if ((toolUse.name === "Agent" || toolUse.name === "Task") && description) {
    return description
  }

  if (toolUse.name === "TaskOutput") {
    return null
  }

  if (toolUse.name === "Read") {
    const numFiles = isRecord(toolUseResult) ? coerceNumber(toolUseResult.numFiles) : null
    if (numFiles && numFiles > 1) {
      return `Read ${numFiles} files`
    }

    const filePath = extractClaudeToolFilePath(toolUse, toolUseResult)
    return filePath ? `Read ${basename(filePath)}` : "Read file"
  }

  if (toolUse.name === "Bash") {
    if (description) {
      return description
    }

    const command =
      typeof toolUse.input.command === "string"
        ? toolUse.input.command.trim()
        : typeof toolUse.input.cmd === "string"
          ? toolUse.input.cmd.trim()
          : ""

    return command ? `Run ${command}` : "Run command"
  }

  if (toolUse.name === "Grep" || toolUse.name === "ToolSearch") {
    const patternCount = Array.isArray(toolUse.input.patterns)
      ? toolUse.input.patterns.length
      : isNonEmptyString(toolUse.input.pattern)
        ? 1
        : 0

    if (patternCount > 1) {
      return `Searched ${patternCount} patterns`
    }

    return toolUse.name === "ToolSearch" ? "Search files" : "Search code"
  }

  if (toolUse.name === "Glob") {
    const numFiles = isRecord(toolUseResult) ? coerceNumber(toolUseResult.numFiles) : null
    return numFiles && numFiles > 0 ? `Listed ${numFiles} files` : "List matching files"
  }

  if (["Write", "Edit", "MultiEdit"].includes(toolUse.name)) {
    const filePath = extractClaudeToolFilePath(toolUse, toolUseResult)
    return filePath ? `Update ${basename(filePath)}` : "Update file"
  }

  if (description) {
    return description
  }

  return toolUse.name.replace(/([a-z])([A-Z])/g, "$1 $2")
}

function buildClaudePatch(
  toolUse: ClaudeToolUseRecord | null,
  toolUseResult: Record<string, unknown>
) {
  const editableToolNames = new Set(["Write", "Edit", "MultiEdit"])
  const type =
    typeof toolUseResult.type === "string" ? toolUseResult.type.toLowerCase() : null

  if (toolUse && !editableToolNames.has(toolUse.name) && type !== "create" && type !== "delete") {
    return null
  }

  const filePath = extractClaudeToolFilePath(toolUse, toolUseResult)
  if (!filePath) {
    return null
  }

  const structuredPatch = Array.isArray(toolUseResult.structuredPatch)
    ? toolUseResult.structuredPatch
    : null

  if (structuredPatch && structuredPatch.length > 0) {
    const operation: "add" | "update" | "delete" =
      type === "create" ? "add" : type === "delete" ? "delete" : "update"

    return buildStructuredPatchString({
      filePath,
      operation,
      structuredPatch
    })
  }

  const content = typeof toolUseResult.content === "string" ? toolUseResult.content : null
  const originalFile =
    typeof toolUseResult.originalFile === "string" ? toolUseResult.originalFile : null

  if ((type === "create" || (!originalFile && content !== null)) && content !== null) {
    return buildAddFilePatch(filePath, content)
  }

  const operation: "add" | "update" | "delete" =
    type === "create" ? "add" : type === "delete" ? "delete" : "update"

  return ["*** Begin Patch", buildPatchHeader(operation, filePath), "*** End Patch"].join(
    "\n"
  )
}

function buildClaudeTranscriptData(lines: string[]): ParsedTranscriptData {
  const entries: ConversationEntry[] = []
  const toolUses = new Map<string, ClaudeToolUseRecord>()
  let thoughtSteps: AssistantThoughtChainEntry["messages"] = []
  let thoughtChainTimestamp: string | null = null
  let pendingPatches: ConversationPatch[] = []
  let messageCounter = 0
  let patchCounter = 0
  let thoughtChainCounter = 0
  let sessionCwd: string | null = null
  let lastAssistantMarkdown: string | null = null
  let hasDiffs = false

  function addThoughtStep(timestamp: string, bodyMarkdown: string) {
    if (!bodyMarkdown.trim()) {
      return
    }

    if (!thoughtChainTimestamp) {
      thoughtChainTimestamp = timestamp
    }

    thoughtSteps.push({
      id: `thought-step-${thoughtSteps.length + 1}`,
      bodyMarkdown: bodyMarkdown.trim()
    })
  }

  function flushThoughtChain() {
    if (thoughtSteps.length === 0) {
      return
    }

    thoughtChainCounter += 1
    entries.push({
      id: `thought-chain-${thoughtChainCounter}`,
      kind: "thought_chain",
      role: "assistant",
      timestamp: thoughtChainTimestamp ?? "",
      collapsedByDefault: true,
      messageCount: thoughtSteps.length,
      messages: thoughtSteps
    })
    thoughtSteps = []
    thoughtChainTimestamp = null
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.trim()
    if (!line) {
      continue
    }

    let record: JsonRecord
    try {
      record = JSON.parse(line) as JsonRecord
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid JSON on line ${lineIndex + 1}: ${message}`)
    }

    const timestamp = typeof record.timestamp === "string" ? record.timestamp : ""
    if (!sessionCwd && typeof record.cwd === "string" && record.cwd.trim()) {
      sessionCwd = record.cwd
    }

    if (record.type === "assistant") {
      const message = isRecord(record.message) ? record.message : {}
      const stopReason = typeof message.stop_reason === "string" ? message.stop_reason : null
      const content = Array.isArray(message.content)
        ? message.content.filter(isRecord)
        : []

      const textParts = content
        .filter(item => item.type === "text")
        .map(item => (typeof item.text === "string" ? item.text.trim() : ""))
        .filter(Boolean)

      for (const item of content) {
        if (item.type !== "tool_use") {
          continue
        }

        const toolId = typeof item.id === "string" ? item.id : null
        const toolName = typeof item.name === "string" ? item.name : null
        const input = isRecord(item.input) ? item.input : {}

        if (!toolId || !toolName) {
          continue
        }

        toolUses.set(toolId, {
          id: toolId,
          name: toolName,
          input,
          timestamp
        })
      }

      if (textParts.length === 0) {
        continue
      }

      const text = textParts.join("\n\n").trim()
      if (!text) {
        continue
      }

      if (stopReason === "end_turn") {
        flushThoughtChain()
        messageCounter += 1
        entries.push({
          id: `message-${messageCounter}`,
          kind: "message",
          role: "assistant",
          timestamp,
          bodyMarkdown: text,
          patches: pendingPatches
        })
        lastAssistantMarkdown = text
        hasDiffs = hasDiffs || pendingPatches.length > 0
        pendingPatches = []
        continue
      }

      addThoughtStep(timestamp, text)
      continue
    }

    if (record.type !== "user") {
      continue
    }

    if (record.isMeta === true) {
      continue
    }

    const message = isRecord(record.message) ? record.message : {}
    const toolUseResult = isRecord(record.toolUseResult) ? record.toolUseResult : null

    if (toolUseResult) {
      const content = Array.isArray(message.content)
        ? message.content.filter(isRecord)
        : []
      const toolUseId = content.find(item => item.type === "tool_result")?.tool_use_id
      const matchedToolUse =
        typeof toolUseId === "string" ? toolUses.get(toolUseId) ?? null : null

      if (matchedToolUse) {
        const summary = summarizeClaudeToolResult(matchedToolUse, toolUseResult)
        if (summary) {
          addThoughtStep(timestamp || matchedToolUse.timestamp, summary)
        }
      }

      const patch = buildClaudePatch(matchedToolUse, toolUseResult)
      if (patch) {
        patchCounter += 1
        pendingPatches.push({
          id: `patch-${patchCounter}`,
          patch,
          files: extractPatchFiles(patch)
        })
      }
      continue
    }

    const text = extractClaudeTextContent(message)
    if (!text) {
      continue
    }

    flushThoughtChain()
    messageCounter += 1
    entries.push({
      id: `message-${messageCounter}`,
      kind: "message",
      role: "user",
      timestamp,
      bodyMarkdown: text
    })
  }

  flushThoughtChain()

  return {
    entries,
    lastAssistantMarkdown,
    hasDiffs,
    sessionMeta: {
      client: "cli",
      cwd: sessionCwd
    }
  }
}

function findLastAssistantMarkdown(entries: ConversationEntry[]) {
  const assistantIndex = findLastIndex(
    entries,
    entry => entry.kind === "message" && entry.role === "assistant"
  )

  if (assistantIndex === null) {
    return null
  }

  const entry = entries[assistantIndex]
  return entry && entry.kind === "message" ? entry.bodyMarkdown : null
}

export function buildConversationTranscript(params: {
  sessionContent: string
  session: SessionIndexEntry
  sessionPath: string | null
  options: TranscriptOptions
}): ConversationTranscript {
  const { options, session, sessionContent, sessionPath } = params
  const lines = sessionContent.split(/\r?\n/)
  const parsed =
    session.provider === "claude"
      ? buildClaudeTranscriptData(lines)
      : buildCodexTranscriptData(lines)

  return {
    id: session.id,
    sourceSessionId: session.sourceSessionId,
    provider: session.provider,
    archived: session.archived,
    threadName: session.threadName,
    updatedAt: session.updatedAt,
    sessionPath,
    projectPath: session.projectPath ?? parsed.sessionMeta.cwd,
    sessionClient:
      session.provider === "claude" ? "cli" : parsed.sessionMeta.client,
    sessionCwd: parsed.sessionMeta.cwd,
    entries: parsed.entries,
    markdown: renderMarkdown(parsed.entries, options.includeDiffs, options.includeCommentary),
    lastAssistantMarkdown: parsed.lastAssistantMarkdown,
    hasDiffs: parsed.hasDiffs
  }
}
