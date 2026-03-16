import { randomUUID } from "node:crypto"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

import type {
  AgentBridgeConfigSnippets,
  AgentBridgeHealth,
  AgentCallerMetadata,
  AgentDefinition,
  AgentRunRecord,
  AskAgentParams,
  AskAgentResult,
  HandoffSettings,
  SessionProvider,
  StartAgentRunResult,
  ThinkingLevel
} from "../shared/contracts"
import { createHandoffSettingsStore } from "./settings"

export const AGENT_BRIDGE_MODE_ARG = "--agent-bridge-mcp"
export const AGENT_BRIDGE_WORKER_MODE_ARG = "--agent-bridge-worker"
export const AGENT_BRIDGE_SERVER_NAME = "handoff-agent-bridge"

const MAX_TIMEOUT_SEC = 1_800
const MAX_WAIT_FOR_RUN_SEC = 30
const STALE_LOCK_MS = 6 * 60 * 60 * 1_000

type AgentBridgeEventType =
  | "started"
  | "updated"
  | "completed"
  | "failed"
  | "canceled"

interface AgentRunEvent {
  event: AgentBridgeEventType
  at: string
  record: Partial<AgentRunRecord> & Pick<AgentRunRecord, "runId" | "agentId">
}

interface CommandExecutionParams {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs: number | null
}

interface CommandExecutionResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

type CommandExecutor = (
  params: CommandExecutionParams
) => Promise<CommandExecutionResult>

interface BridgeCommandConfig {
  command: string
  args: string[]
}

export interface AgentBridgeServiceOptions {
  dataDir: string
  codexHome: string
  claudeHome: string
  bridgeCommand: BridgeCommandConfig
  executeCommand?: CommandExecutor
  workerCommand?: BridgeCommandConfig
  spawnWorkerProcess?: (params: {
    command: string
    args: string[]
    runId: string
  }) => Promise<number | null>
}

export interface AgentBusyInfo {
  runId: string
  startedAt: string
  workerPid?: number | null
}

export class AgentBridgeBusyError extends Error {
  readonly code = "busy"

  constructor(
    message: string,
    readonly info: AgentBusyInfo
  ) {
    super(message)
  }
}

export class AgentBridgeInputError extends Error {
  constructor(
    readonly code:
      | "invalid_agent"
      | "invalid_project_path"
      | "invalid_message"
      | "invalid_timeout",
    message: string
  ) {
    super(message)
  }
}

export interface AgentBridgeService {
  getStatus(): Promise<AgentBridgeHealth>
  getConfigSnippets(): Promise<AgentBridgeConfigSnippets>
  listAgents(): Promise<AgentDefinition[]>
  getAgent(params: {
    agentId?: string
    agentName?: string
  }): Promise<AgentDefinition | null>
  startRun(params: Omit<AskAgentParams, "timeoutSec">): Promise<StartAgentRunResult>
  waitForRun(runId: string, waitUpToSec?: number): Promise<AgentRunRecord | null>
  askAgent(params: AskAgentParams): Promise<AskAgentResult>
  listRuns(agentId?: string, limit?: number): Promise<AgentRunRecord[]>
  getRun(runId: string): Promise<AgentRunRecord | null>
  cancelRun(runId: string): Promise<AgentRunRecord | null>
}

interface CodexLaunchInfo {
  provider: "codex"
  binaryPath: string
  homePath: string
}

interface ClaudeLaunchInfo {
  provider: "claude"
  binaryPath: string
  settingsPath: string | null
}

type ProviderLaunchInfo = CodexLaunchInfo | ClaudeLaunchInfo

interface AgentRunRequest {
  runId: string
  startedAt: string
  projectPath: string
  message: string
  context: string | null
  caller: AgentCallerMetadata
  prompt: string
  timeoutSec: number | null
  agent: AgentDefinition
  launchInfo: ProviderLaunchInfo
}

function expandHomePath(value: string) {
  if (value === "~") {
    return os.homedir()
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2))
  }

  return value
}

function normalizeCallerMetadata(value: AgentCallerMetadata | undefined): AgentCallerMetadata {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value === "string") {
    return value
  }

  if (typeof value === "object") {
    return value as Record<string, unknown>
  }

  return null
}

function normalizeTimeoutSec(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return null
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new AgentBridgeInputError("invalid_timeout", "Timeout must be a positive number.")
  }

  return Math.min(Math.floor(value), MAX_TIMEOUT_SEC)
}

function normalizeWaitUpToSec(value: number | undefined) {
  if (value === undefined) {
    return 20
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new AgentBridgeInputError(
      "invalid_timeout",
      "Wait duration must be a positive number."
    )
  }

  return Math.min(Math.floor(value), MAX_WAIT_FOR_RUN_SEC)
}

function delay(ms: number) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function mapThinkingLevelToCodexEffort(thinkingLevel: ThinkingLevel) {
  return thinkingLevel === "max" ? "xhigh" : thinkingLevel
}

function mapThinkingLevelToClaudeEffort(thinkingLevel: ThinkingLevel) {
  return thinkingLevel
}

function shellEscape(value: string) {
  if (!value) {
    return "''"
  }

  return `'${value.replaceAll("'", `'\\''`)}'`
}

function buildCodexLaunchInfo(settings: HandoffSettings, codexHome: string) {
  const overrides = settings.providers.codex
  return {
    provider: "codex" as const,
    binaryPath: expandHomePath(overrides.binaryPath.trim() || "codex"),
    homePath: expandHomePath(overrides.homePath.trim() || codexHome)
  }
}

function buildClaudeLaunchInfo(settings: HandoffSettings, claudeHome: string) {
  const overrides = settings.providers.claude
  const effectiveHomePath = expandHomePath(overrides.homePath.trim() || claudeHome)
  const settingsPath = path.join(effectiveHomePath, "settings.json")

  return {
    provider: "claude" as const,
    binaryPath: expandHomePath(overrides.binaryPath.trim() || "claude"),
    settingsPath: fs.existsSync(settingsPath) ? settingsPath : null
  }
}

function buildAgentPrompt(params: {
  agent: AgentDefinition
  message: string
  context: string | null
}) {
  const sections: string[] = [
    `You are the saved Handoff agent "${params.agent.name}".`,
    "Respond with one final answer."
  ]

  if (params.agent.customInstructions.trim()) {
    sections.push(
      [
        "<agent_instructions>",
        params.agent.customInstructions.trim(),
        "</agent_instructions>"
      ].join("\n")
    )
  }

  if (params.context?.trim()) {
    sections.push(["<context>", params.context.trim(), "</context>"].join("\n"))
  }

  sections.push(["<question>", params.message.trim(), "</question>"].join("\n"))
  return sections.join("\n\n")
}

function buildCodexExecArgs(params: {
  agent: AgentDefinition
  projectPath: string
  prompt: string
  lastMessagePath: string
}) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    params.projectPath,
    "--model",
    params.agent.modelId,
    "-c",
    `model_reasoning_effort="${mapThinkingLevelToCodexEffort(params.agent.thinkingLevel)}"`,
    "-o",
    params.lastMessagePath,
    "-"
  ]

  if (params.agent.fast) {
    args.push("-c", 'service_tier="fast"')
  }

  return args
}

function buildClaudeExecArgs(params: {
  agent: AgentDefinition
  prompt: string
  settingsPath: string | null
}) {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    params.agent.modelId,
    "--effort",
    mapThinkingLevelToClaudeEffort(params.agent.thinkingLevel)
  ]

  if (params.settingsPath) {
    args.push("--settings", params.settingsPath)
  }

  args.push(params.prompt)
  return args
}

function extractTextContent(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => extractTextContent(item))
  }

  if (!value || typeof value !== "object") {
    return []
  }

  const record = value as Record<string, unknown>

  if (record.type === "text" && typeof record.text === "string") {
    return extractTextContent(record.text)
  }

  if (typeof record.result === "string") {
    return extractTextContent(record.result)
  }

  if (typeof record.answer === "string") {
    return extractTextContent(record.answer)
  }

  if (typeof record.output_text === "string") {
    return extractTextContent(record.output_text)
  }

  if (Array.isArray(record.messages)) {
    const assistantMessages = record.messages.filter(message => {
      return (
        message &&
        typeof message === "object" &&
        "role" in message &&
        (message as { role?: unknown }).role === "assistant"
      )
    })

    return extractTextContent(
      assistantMessages.length > 0
        ? assistantMessages[assistantMessages.length - 1]
        : record.messages
    )
  }

  if (
    record.message &&
    typeof record.message === "object" &&
    (record.message as { role?: unknown }).role === "assistant"
  ) {
    return extractTextContent(record.message)
  }

  if (record.role === "assistant" && "content" in record) {
    return extractTextContent(record.content)
  }

  if ("content" in record) {
    return extractTextContent(record.content)
  }

  return []
}

function parseClaudeAnswer(stdout: string) {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed)
    const text = extractTextContent(parsed).join("\n\n").trim()
    return text || trimmed
  } catch {
    return trimmed
  }
}

function parseCodexJsonlAnswer(stdout: string) {
  const candidates: string[] = []

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    try {
      const parsed = JSON.parse(line)
      const extracted = extractTextContent(parsed).join("\n\n").trim()
      if (extracted) {
        candidates.push(extracted)
      }
    } catch {
      continue
    }
  }

  return candidates.at(-1) ?? null
}

async function defaultExecuteCommand(
  params: CommandExecutionParams
): Promise<CommandExecutionResult> {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let didFinish = false
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: "pipe"
    })

    const timer =
      params.timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true
            child.kill("SIGTERM")
            setTimeout(() => {
              if (!didFinish) {
                child.kill("SIGKILL")
              }
            }, 4_000).unref()
          }, params.timeoutMs)

    child.stdout.on("data", chunk => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", chunk => {
      stderr += chunk.toString()
    })

    child.on("error", error => {
      if (timer) {
        clearTimeout(timer)
      }
      reject(error)
    })

    child.on("close", (exitCode, signal) => {
      didFinish = true
      if (timer) {
        clearTimeout(timer)
      }
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut
      })
    })

    if (params.stdin) {
      child.stdin.end(params.stdin)
      return
    }

    child.stdin.end()
  })
}

async function ensureDirectory(dirPath: string) {
  await fsPromises.mkdir(dirPath, { recursive: true })
}

async function ensureProjectPath(projectPath: string) {
  if (!path.isAbsolute(projectPath)) {
    throw new AgentBridgeInputError(
      "invalid_project_path",
      "Project path must be an absolute directory."
    )
  }

  let stat
  try {
    stat = await fsPromises.stat(projectPath)
  } catch {
    throw new AgentBridgeInputError(
      "invalid_project_path",
      `Project path not found: ${projectPath}`
    )
  }

  if (!stat.isDirectory()) {
    throw new AgentBridgeInputError(
      "invalid_project_path",
      `Project path is not a directory: ${projectPath}`
    )
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fsPromises.readFile(filePath, "utf8")
    return JSON.parse(content) as T
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null
    }

    throw error
  }
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fsPromises.readFile(filePath, "utf8")
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as T]
        } catch {
          return []
        }
      })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return []
    }

    throw error
  }
}

function materializeRunRecords(events: AgentRunEvent[]) {
  const runsById = new Map<string, AgentRunRecord>()

  for (const event of events) {
    if (event.event === "started") {
      const currentRecord = event.record as AgentRunRecord
      runsById.set(currentRecord.runId, currentRecord)
      continue
    }

    const currentRecord = runsById.get(event.record.runId)
    if (!currentRecord) {
      continue
    }

    runsById.set(event.record.runId, {
      ...currentRecord,
      ...event.record
    })
  }

  return [...runsById.values()].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt)
  )
}

async function readRunRecords(runsLogPath: string) {
  return materializeRunRecords(await readJsonLines<AgentRunEvent>(runsLogPath))
}

async function appendRunEvent(runsLogPath: string, event: AgentRunEvent) {
  await ensureDirectory(path.dirname(runsLogPath))
  await fsPromises.appendFile(runsLogPath, `${JSON.stringify(event)}\n`, "utf8")
}

function buildLockFilePath(locksDir: string, agentId: string) {
  return path.join(locksDir, `${agentId}.json`)
}

async function readLockInfo(lockPath: string): Promise<AgentBusyInfo | null> {
  try {
    const content = await fsPromises.readFile(lockPath, "utf8")
    const parsed = JSON.parse(content) as Partial<AgentBusyInfo>
    if (
      typeof parsed.runId === "string" &&
      parsed.runId &&
      typeof parsed.startedAt === "string" &&
      parsed.startedAt
    ) {
      return {
        runId: parsed.runId,
        startedAt: parsed.startedAt,
        workerPid:
          typeof parsed.workerPid === "number" && Number.isFinite(parsed.workerPid)
            ? parsed.workerPid
            : null
      }
    }
  } catch {
    return null
  }

  return null
}

async function writeLockInfo(lockPath: string, info: AgentBusyInfo) {
  await ensureDirectory(path.dirname(lockPath))
  await fsPromises.writeFile(lockPath, JSON.stringify(info, null, 2), "utf8")
}

function isTerminalRunStatus(status: AgentRunRecord["status"]) {
  return status === "completed" || status === "failed" || status === "canceled"
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function reconcileAgentLock(params: {
  lockPath: string
  runsLogPath: string
}) {
  const lockInfo = await readLockInfo(params.lockPath)

  if (!lockInfo) {
    await fsPromises.unlink(params.lockPath).catch(() => undefined)
    return null
  }

  const runs = await readRunRecords(params.runsLogPath)
  const existingRun =
    lockInfo.runId ? runs.find(run => run.runId === lockInfo.runId) ?? null : null

  if (existingRun && isTerminalRunStatus(existingRun.status)) {
    await fsPromises.unlink(params.lockPath).catch(() => undefined)
    return null
  }

  if (lockInfo.workerPid && !isProcessAlive(lockInfo.workerPid)) {
    const finishedAt = new Date().toISOString()

    if (existingRun && existingRun.status === "running") {
      await appendRunEvent(params.runsLogPath, {
        event: "failed",
        at: finishedAt,
        record: {
          runId: existingRun.runId,
          agentId: existingRun.agentId,
          status: "failed",
          finishedAt,
          error: "Worker process exited unexpectedly.",
          workerPid: lockInfo.workerPid
        }
      })
    }

    await fsPromises.unlink(params.lockPath).catch(() => undefined)
    return null
  }

  if (Date.now() - new Date(lockInfo.startedAt).getTime() > STALE_LOCK_MS) {
    await fsPromises.unlink(params.lockPath).catch(() => undefined)
    return null
  }

  return lockInfo
}

async function acquireAgentLock(params: {
  locksDir: string
  agentId: string
  info: AgentBusyInfo
  runsLogPath: string
}) {
  await ensureDirectory(params.locksDir)
  const lockPath = buildLockFilePath(params.locksDir, params.agentId)

  try {
    const handle = await fsPromises.open(lockPath, "wx")
    await handle.writeFile(JSON.stringify(params.info, null, 2), "utf8")
    await handle.close()
    return lockPath
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
      throw error
    }

    const lockInfo = await reconcileAgentLock({
      lockPath,
      runsLogPath: params.runsLogPath
    })

    if (!lockInfo) {
      return acquireAgentLock(params)
    }

    throw new AgentBridgeBusyError("Agent is already handling a request.", {
      runId: lockInfo?.runId ?? "unknown",
      startedAt: lockInfo?.startedAt ?? new Date(0).toISOString(),
      workerPid: lockInfo?.workerPid ?? null
    })
  }
}

async function releaseAgentLock(lockPath: string | null) {
  if (!lockPath) {
    return
  }

  await fsPromises.unlink(lockPath).catch(() => undefined)
}

function buildRequestFilePath(requestsDir: string, runId: string) {
  return path.join(requestsDir, `${runId}.json`)
}

async function readRunRequest(requestsDir: string, runId: string) {
  return readJsonFile<AgentRunRequest>(buildRequestFilePath(requestsDir, runId))
}

async function writeRunRequest(requestsDir: string, request: AgentRunRequest) {
  const requestPath = buildRequestFilePath(requestsDir, request.runId)
  await ensureDirectory(path.dirname(requestPath))
  await fsPromises.writeFile(requestPath, JSON.stringify(request, null, 2), "utf8")
  return requestPath
}

async function removeRunRequest(requestsDir: string, runId: string) {
  await fsPromises.unlink(buildRequestFilePath(requestsDir, runId)).catch(() => undefined)
}

function killWorkerProcess(pid: number) {
  try {
    process.kill(-pid, "SIGTERM")
    return true
  } catch {
    try {
      process.kill(pid, "SIGTERM")
      return true
    } catch {
      return false
    }
  }
}

function resolveAgentByIdentity(
  agents: AgentDefinition[],
  params: {
    agentId?: string
    agentName?: string
  }
) {
  const agentId = params.agentId?.trim()
  if (agentId) {
    return agents.find(agent => agent.id === agentId) ?? null
  }

  const agentName = params.agentName?.trim()
  if (agentName) {
    const exactMatch =
      agents.find(agent => agent.name.trim() === agentName) ??
      agents.find(agent => agent.name.trim().toLowerCase() === agentName.toLowerCase())
    return exactMatch ?? null
  }

  return null
}

function buildCodexSnippet(command: string, args: string[]) {
  return [
    "codex mcp add handoff-agent-bridge --",
    shellEscape(command),
    ...args.map(shellEscape)
  ].join(" ")
}

function buildClaudeSnippet(command: string, args: string[]) {
  return JSON.stringify(
    {
      mcpServers: {
        "handoff-agent-bridge": {
          command,
          args
        }
      }
    },
    null,
    2
  )
}

function buildBridgeStatePaths(dataDir: string) {
  const stateDir = path.join(dataDir, "agent-bridge")
  return {
    stateDir,
    runsLogPath: path.join(stateDir, "runs.jsonl"),
    locksDir: path.join(stateDir, "locks"),
    requestsDir: path.join(stateDir, "requests"),
    tmpDir: path.join(stateDir, "tmp")
  }
}

function deriveWorkerCommand(bridgeCommand: BridgeCommandConfig): BridgeCommandConfig {
  const nextArgs = bridgeCommand.args.includes(AGENT_BRIDGE_MODE_ARG)
    ? bridgeCommand.args.map(arg =>
        arg === AGENT_BRIDGE_MODE_ARG ? AGENT_BRIDGE_WORKER_MODE_ARG : arg
      )
    : [...bridgeCommand.args, AGENT_BRIDGE_WORKER_MODE_ARG]

  return {
    command: bridgeCommand.command,
    args: nextArgs
  }
}

async function defaultSpawnWorkerProcess(params: {
  command: string
  args: string[]
  runId: string
}) {
  const child = spawn(params.command, [...params.args, params.runId], {
    detached: true,
    stdio: "ignore"
  })
  child.unref()
  return child.pid ?? null
}

function buildBaseRunRecord(params: {
  runId: string
  startedAt: string
  agent: AgentDefinition
  projectPath: string
  message: string
  context: string | null
  caller: AgentCallerMetadata
  prompt: string
}) {
  return {
    runId: params.runId,
    agentId: params.agent.id,
    agentName: params.agent.name,
    status: "running" as const,
    provider: params.agent.provider,
    modelId: params.agent.modelId,
    thinkingLevel: params.agent.thinkingLevel,
    fast: params.agent.fast,
    projectPath: params.projectPath,
    message: params.message,
    context: params.context,
    caller: params.caller,
    prompt: params.prompt,
    answer: null,
    error: null,
    stdout: null,
    stderr: null,
    exitCode: null,
    workerPid: null,
    startedAt: params.startedAt,
    finishedAt: null
  } satisfies AgentRunRecord
}

interface ProviderExecutionResult extends CommandExecutionResult {
  answer: string | null
}

async function runCodexAgent(params: {
  agent: AgentDefinition
  launchInfo: CodexLaunchInfo
  projectPath: string
  prompt: string
  timeoutSec: number | null
  tmpDir: string
  executeCommand: CommandExecutor
}) {
  const lastMessagePath = path.join(
    params.tmpDir,
    `${params.agent.id}-${randomUUID()}.md`
  )
  await ensureDirectory(path.dirname(lastMessagePath))

  const result = await params.executeCommand({
    command: params.launchInfo.binaryPath,
    args: buildCodexExecArgs({
      agent: params.agent,
      projectPath: params.projectPath,
      prompt: params.prompt,
      lastMessagePath
    }),
    cwd: params.projectPath,
    env: {
      ...process.env,
      CODEX_HOME: params.launchInfo.homePath
    },
    stdin: params.prompt,
    timeoutMs: params.timeoutSec === null ? null : params.timeoutSec * 1_000
  })

  let answer: string | null = null
  try {
    answer = (await fsPromises.readFile(lastMessagePath, "utf8")).trim() || null
  } catch {
    answer = null
  } finally {
    await fsPromises.unlink(lastMessagePath).catch(() => undefined)
  }

  return {
    ...result,
    answer: answer ?? parseCodexJsonlAnswer(result.stdout)
  } satisfies ProviderExecutionResult
}

async function runClaudeAgent(params: {
  agent: AgentDefinition
  launchInfo: ClaudeLaunchInfo
  projectPath: string
  prompt: string
  timeoutSec: number | null
  executeCommand: CommandExecutor
}) {
  const result = await params.executeCommand({
    command: params.launchInfo.binaryPath,
    args: buildClaudeExecArgs({
      agent: params.agent,
      prompt: params.prompt,
      settingsPath: params.launchInfo.settingsPath
    }),
    cwd: params.projectPath,
    env: process.env,
    timeoutMs: params.timeoutSec === null ? null : params.timeoutSec * 1_000
  })

  return {
    ...result,
    answer: parseClaudeAnswer(result.stdout)
  } satisfies ProviderExecutionResult
}

async function executeAgentRun(params: {
  request: AgentRunRequest
  tmpDir: string
  executeCommand: CommandExecutor
}) {
  if (params.request.launchInfo.provider === "codex") {
    return runCodexAgent({
      agent: params.request.agent,
      launchInfo: params.request.launchInfo,
      projectPath: params.request.projectPath,
      prompt: params.request.prompt,
      timeoutSec: params.request.timeoutSec,
      tmpDir: params.tmpDir,
      executeCommand: params.executeCommand
    })
  }

  return runClaudeAgent({
    agent: params.request.agent,
    launchInfo: params.request.launchInfo,
    projectPath: params.request.projectPath,
    prompt: params.request.prompt,
    timeoutSec: params.request.timeoutSec,
    executeCommand: params.executeCommand
  })
}

async function getRunRecord(runsLogPath: string, runId: string) {
  return (await readRunRecords(runsLogPath)).find(run => run.runId === runId) ?? null
}

async function appendFailureIfStillRunning(params: {
  runsLogPath: string
  runId: string
  agentId: string
  error: string
}) {
  const currentRun = await getRunRecord(params.runsLogPath, params.runId)

  if (!currentRun || currentRun.status !== "running") {
    return currentRun
  }

  const finishedAt = new Date().toISOString()
  await appendRunEvent(params.runsLogPath, {
    event: "failed",
    at: finishedAt,
    record: {
      runId: params.runId,
      agentId: params.agentId,
      status: "failed",
      finishedAt,
      error: params.error
    }
  })

  return getRunRecord(params.runsLogPath, params.runId)
}

async function finalizeRunExecution(params: {
  runsLogPath: string
  request: AgentRunRequest
  result: ProviderExecutionResult
}) {
  const currentRun = await getRunRecord(params.runsLogPath, params.request.runId)

  if (!currentRun || currentRun.status !== "running") {
    return currentRun
  }

  const finishedAt = new Date().toISOString()

  if (params.result.timedOut) {
    await appendRunEvent(params.runsLogPath, {
      event: "failed",
      at: finishedAt,
      record: {
        runId: params.request.runId,
        agentId: params.request.agent.id,
        status: "failed",
        finishedAt,
        answer: params.result.answer,
        error:
          params.request.timeoutSec === null
            ? "Timed out."
            : `Timed out after ${params.request.timeoutSec} seconds.`,
        stdout: params.result.stdout || null,
        stderr: params.result.stderr || null,
        exitCode: params.result.exitCode
      }
    })

    return getRunRecord(params.runsLogPath, params.request.runId)
  }

  if (params.result.exitCode !== 0) {
    const errorText =
      params.result.stderr.trim() ||
      params.result.stdout.trim() ||
      `Provider command exited with code ${params.result.exitCode}.`

    await appendRunEvent(params.runsLogPath, {
      event: "failed",
      at: finishedAt,
      record: {
        runId: params.request.runId,
        agentId: params.request.agent.id,
        status: "failed",
        finishedAt,
        answer: params.result.answer,
        error: errorText,
        stdout: params.result.stdout || null,
        stderr: params.result.stderr || null,
        exitCode: params.result.exitCode
      }
    })

    return getRunRecord(params.runsLogPath, params.request.runId)
  }

  if (!params.result.answer) {
    await appendRunEvent(params.runsLogPath, {
      event: "failed",
      at: finishedAt,
      record: {
        runId: params.request.runId,
        agentId: params.request.agent.id,
        status: "failed",
        finishedAt,
        error: "Provider command completed without a final answer.",
        stdout: params.result.stdout || null,
        stderr: params.result.stderr || null,
        exitCode: params.result.exitCode
      }
    })

    return getRunRecord(params.runsLogPath, params.request.runId)
  }

  await appendRunEvent(params.runsLogPath, {
    event: "completed",
    at: finishedAt,
    record: {
      runId: params.request.runId,
      agentId: params.request.agent.id,
      status: "completed",
      finishedAt,
      answer: params.result.answer,
      stdout: params.result.stdout || null,
      stderr: params.result.stderr || null,
      exitCode: params.result.exitCode
    }
  })

  return getRunRecord(params.runsLogPath, params.request.runId)
}

async function releaseLockForRun(params: {
  locksDir: string
  agentId: string
  runId: string
}) {
  const lockPath = buildLockFilePath(params.locksDir, params.agentId)
  const lockInfo = await readLockInfo(lockPath)

  if (lockInfo?.runId === params.runId) {
    await releaseAgentLock(lockPath)
  }
}

async function reconcileAllAgentLocks(params: {
  locksDir: string
  runsLogPath: string
}) {
  await ensureDirectory(params.locksDir)
  const fileNames = await fsPromises.readdir(params.locksDir).catch(() => [])

  await Promise.all(
    fileNames
      .filter(fileName => fileName.endsWith(".json"))
      .map(fileName =>
        reconcileAgentLock({
          lockPath: path.join(params.locksDir, fileName),
          runsLogPath: params.runsLogPath
        })
      )
  )
}

export async function runAgentBridgeWorkerJob(params: {
  dataDir: string
  runId: string
  executeCommand?: CommandExecutor
}) {
  const executeCommand = params.executeCommand ?? defaultExecuteCommand
  const { runsLogPath, locksDir, requestsDir, tmpDir } = buildBridgeStatePaths(params.dataDir)
  const request = await readRunRequest(requestsDir, params.runId)

  if (!request) {
    return null
  }

  try {
    const result = await executeAgentRun({
      request,
      tmpDir,
      executeCommand
    })

    return await finalizeRunExecution({
      runsLogPath,
      request,
      result
    })
  } catch (error) {
    return appendFailureIfStillRunning({
      runsLogPath,
      runId: request.runId,
      agentId: request.agent.id,
      error: error instanceof Error ? error.message : "Provider execution failed."
    })
  } finally {
    await removeRunRequest(requestsDir, params.runId)
    await releaseLockForRun({
      locksDir,
      agentId: request.agent.id,
      runId: request.runId
    })
  }
}

export function createAgentBridgeService(
  options: AgentBridgeServiceOptions
): AgentBridgeService {
  const executeCommand = options.executeCommand ?? defaultExecuteCommand
  const spawnWorkerProcess = options.spawnWorkerProcess ?? defaultSpawnWorkerProcess
  const settingsStore = createHandoffSettingsStore({
    dataDir: options.dataDir,
    codexHome: options.codexHome,
    claudeHome: options.claudeHome
  })
  const { stateDir, runsLogPath, locksDir, requestsDir, tmpDir } = buildBridgeStatePaths(
    options.dataDir
  )
  const workerCommand = options.workerCommand ?? deriveWorkerCommand(options.bridgeCommand)

  async function getSettings() {
    return settingsStore.getSettings()
  }

  async function listAgents() {
    return settingsStore.listAgents()
  }

  async function getAgent(params: {
    agentId?: string
    agentName?: string
  }) {
    return resolveAgentByIdentity(await listAgents(), params)
  }

  async function buildRunRequest(params: Omit<AskAgentParams, "timeoutSec">) {
    const message = params.message.trim()
    if (!message) {
      throw new AgentBridgeInputError("invalid_message", "Message is required.")
    }

    await ensureProjectPath(params.projectPath)
    const settings = await getSettings()
    const agent = resolveAgentByIdentity(settings.agents, params)

    if (!agent) {
      throw new AgentBridgeInputError(
        "invalid_agent",
        "Agent not found. Provide a valid agentId or exact agent name."
      )
    }

    const context = params.context?.trim() ? params.context.trim() : null
    const timeoutSec = normalizeTimeoutSec(agent.timeoutSec)
    const prompt = buildAgentPrompt({
      agent,
      message,
      context
    })
    const startedAt = new Date().toISOString()
    const runId = randomUUID()
    const launchInfo =
      agent.provider === "codex"
        ? buildCodexLaunchInfo(settings, options.codexHome)
        : buildClaudeLaunchInfo(settings, options.claudeHome)

    const request: AgentRunRequest = {
      runId,
      startedAt,
      projectPath: params.projectPath,
      message,
      context,
      caller: normalizeCallerMetadata(params.caller),
      prompt,
      timeoutSec,
      agent,
      launchInfo
    }

    return {
      request,
      record: buildBaseRunRecord({
        runId,
        startedAt,
        agent,
        projectPath: params.projectPath,
        message,
        context,
        caller: request.caller,
        prompt
      })
    }
  }

  return {
    async getStatus() {
      return {
        status: "ready",
        message: "Async agent jobs are available through the local MCP bridge.",
        command: options.bridgeCommand.command,
        args: [...options.bridgeCommand.args],
        entrypointLabel: AGENT_BRIDGE_SERVER_NAME,
        stateDir,
        runsLogPath,
        locksDir
      }
    },

    async getConfigSnippets() {
      return {
        codexCommand: buildCodexSnippet(
          options.bridgeCommand.command,
          options.bridgeCommand.args
        ),
        claudeConfigJson: buildClaudeSnippet(
          options.bridgeCommand.command,
          options.bridgeCommand.args
        )
      }
    },

    listAgents,

    getAgent,

    async startRun(params) {
      await reconcileAllAgentLocks({ locksDir, runsLogPath })
      const { request, record } = await buildRunRequest(params)

      const lockPath = await acquireAgentLock({
        locksDir,
        agentId: request.agent.id,
        info: {
          runId: request.runId,
          startedAt: request.startedAt,
          workerPid: null
        },
        runsLogPath
      })

      await appendRunEvent(runsLogPath, {
        event: "started",
        at: request.startedAt,
        record
      })

      try {
        await writeRunRequest(requestsDir, request)
        const workerPid = await spawnWorkerProcess({
          command: workerCommand.command,
          args: workerCommand.args,
          runId: request.runId
        })

        if (workerPid !== null) {
          await appendRunEvent(runsLogPath, {
            event: "updated",
            at: new Date().toISOString(),
            record: {
              runId: request.runId,
              agentId: request.agent.id,
              workerPid
            }
          })
          await writeLockInfo(lockPath, {
            runId: request.runId,
            startedAt: request.startedAt,
            workerPid
          })
        }

        return {
          runId: request.runId,
          status: "running",
          agentId: request.agent.id,
          provider: request.agent.provider,
          modelId: request.agent.modelId,
          thinkingLevel: request.agent.thinkingLevel,
          fast: request.agent.fast,
          projectPath: request.projectPath,
          startedAt: request.startedAt
        }
      } catch (error) {
        await removeRunRequest(requestsDir, request.runId)
        await appendFailureIfStillRunning({
          runsLogPath,
          runId: request.runId,
          agentId: request.agent.id,
          error: error instanceof Error ? error.message : "Failed to start agent worker."
        })
        await releaseAgentLock(lockPath)
        throw error
      }
    },

    async waitForRun(runId, waitUpToSec) {
      const waitMs = normalizeWaitUpToSec(waitUpToSec) * 1_000
      const startedAtMs = Date.now()

      while (true) {
        await reconcileAllAgentLocks({ locksDir, runsLogPath })
        const run = await getRunRecord(runsLogPath, runId)

        if (!run || isTerminalRunStatus(run.status)) {
          return run
        }

        if (Date.now() - startedAtMs >= waitMs) {
          return run
        }

        await delay(500)
      }
    },

    async askAgent(params) {
      await reconcileAllAgentLocks({ locksDir, runsLogPath })
      const { request, record } = await buildRunRequest(params)
      const lockPath = await acquireAgentLock({
        locksDir,
        agentId: request.agent.id,
        info: {
          runId: request.runId,
          startedAt: request.startedAt,
          workerPid: null
        },
        runsLogPath
      })

      await appendRunEvent(runsLogPath, {
        event: "started",
        at: request.startedAt,
        record
      })

      try {
        const result = await executeAgentRun({
          request,
          tmpDir,
          executeCommand
        })
        const finalRun = await finalizeRunExecution({
          runsLogPath,
          request,
          result
        })

        if (!finalRun || finalRun.status !== "completed" || !finalRun.finishedAt) {
          throw new Error(finalRun?.error ?? "Provider execution failed.")
        }

        return {
          runId: finalRun.runId,
          status: "completed",
          answer: finalRun.answer,
          agentId: finalRun.agentId,
          provider: finalRun.provider,
          modelId: finalRun.modelId,
          thinkingLevel: finalRun.thinkingLevel,
          fast: finalRun.fast,
          projectPath: finalRun.projectPath,
          startedAt: finalRun.startedAt,
          finishedAt: finalRun.finishedAt
        }
      } catch (error) {
        if (error instanceof AgentBridgeBusyError || error instanceof AgentBridgeInputError) {
          throw error
        }

        const finalRun = await appendFailureIfStillRunning({
          runsLogPath,
          runId: request.runId,
          agentId: request.agent.id,
          error: error instanceof Error ? error.message : "Provider execution failed."
        })

        throw new Error(finalRun?.error ?? "Provider execution failed.")
      } finally {
        await releaseAgentLock(lockPath)
      }
    },

    async listRuns(agentId, limit = 50) {
      await reconcileAllAgentLocks({ locksDir, runsLogPath })
      const allRuns = await readRunRecords(runsLogPath)
      const filteredRuns = agentId
        ? allRuns.filter(run => run.agentId === agentId)
        : allRuns

      return filteredRuns.slice(0, Math.max(limit, 0))
    },

    async getRun(runId) {
      await reconcileAllAgentLocks({ locksDir, runsLogPath })
      return getRunRecord(runsLogPath, runId)
    },

    async cancelRun(runId) {
      await reconcileAllAgentLocks({ locksDir, runsLogPath })
      const run = await getRunRecord(runsLogPath, runId)

      if (!run) {
        return null
      }

      if (isTerminalRunStatus(run.status)) {
        return run
      }

      const finishedAt = new Date().toISOString()
      await appendRunEvent(runsLogPath, {
        event: "canceled",
        at: finishedAt,
        record: {
          runId: run.runId,
          agentId: run.agentId,
          status: "canceled",
          finishedAt,
          error: "Run canceled."
        }
      })

      if (typeof run.workerPid === "number") {
        killWorkerProcess(run.workerPid)
      }

      await removeRunRequest(requestsDir, run.runId)
      await releaseLockForRun({
        locksDir,
        agentId: run.agentId,
        runId: run.runId
      })

      return getRunRecord(runsLogPath, run.runId)
    }
  }
}
