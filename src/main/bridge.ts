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
  ThinkingLevel
} from "../shared/contracts"
import { createHandoffSettingsStore } from "./settings"

export const AGENT_BRIDGE_MODE_ARG = "--agent-bridge-mcp"
export const AGENT_BRIDGE_SERVER_NAME = "handoff-agent-bridge"

const DEFAULT_TIMEOUT_SEC = 300
const MAX_TIMEOUT_SEC = 1_800

type AgentBridgeEventType = "started" | "completed" | "failed"

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
  timeoutMs: number
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
}

export interface AgentBusyInfo {
  runId: string
  startedAt: string
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
  askAgent(params: AskAgentParams): Promise<AskAgentResult>
  listRuns(agentId?: string, limit?: number): Promise<AgentRunRecord[]>
  getRun(runId: string): Promise<AgentRunRecord | null>
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

function normalizeTimeoutSec(value: number | undefined) {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_SEC
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new AgentBridgeInputError("invalid_timeout", "Timeout must be a positive number.")
  }

  return Math.min(Math.floor(value), MAX_TIMEOUT_SEC)
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
    binaryPath: expandHomePath(overrides.binaryPath.trim() || "codex"),
    homePath: expandHomePath(overrides.homePath.trim() || codexHome)
  }
}

function buildClaudeLaunchInfo(settings: HandoffSettings, claudeHome: string) {
  const overrides = settings.providers.claude
  const effectiveHomePath = expandHomePath(overrides.homePath.trim() || claudeHome)
  const settingsPath = path.join(effectiveHomePath, "settings.json")

  return {
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

    const timer = setTimeout(() => {
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
      clearTimeout(timer)
      reject(error)
    })

    child.on("close", (exitCode, signal) => {
      didFinish = true
      clearTimeout(timer)
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
        startedAt: parsed.startedAt
      }
    }
  } catch {
    return null
  }

  return null
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

    const lockInfo = await readLockInfo(lockPath)
    const runs = await readRunRecords(params.runsLogPath)
    const existingRun =
      lockInfo?.runId
        ? runs.find(run => run.runId === lockInfo.runId) ?? null
        : null

    if (existingRun && existingRun.status !== "running") {
      await fsPromises.unlink(lockPath).catch(() => undefined)
      return acquireAgentLock(params)
    }

    if (
      lockInfo &&
      Date.now() - new Date(lockInfo.startedAt).getTime() > 6 * 60 * 60 * 1_000
    ) {
      await fsPromises.unlink(lockPath).catch(() => undefined)
      return acquireAgentLock(params)
    }

    throw new AgentBridgeBusyError("Agent is already handling a request.", {
      runId: lockInfo?.runId ?? "unknown",
      startedAt: lockInfo?.startedAt ?? new Date(0).toISOString()
    })
  }
}

async function releaseAgentLock(lockPath: string | null) {
  if (!lockPath) {
    return
  }

  await fsPromises.unlink(lockPath).catch(() => undefined)
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

export function createAgentBridgeService(
  options: AgentBridgeServiceOptions
): AgentBridgeService {
  const executeCommand = options.executeCommand ?? defaultExecuteCommand
  const settingsStore = createHandoffSettingsStore({
    dataDir: options.dataDir,
    codexHome: options.codexHome,
    claudeHome: options.claudeHome
  })
  const stateDir = path.join(options.dataDir, "agent-bridge")
  const runsLogPath = path.join(stateDir, "runs.jsonl")
  const locksDir = path.join(stateDir, "locks")

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

  async function runCodexAgent(params: {
    agent: AgentDefinition
    settings: HandoffSettings
    projectPath: string
    prompt: string
    timeoutSec: number
  }) {
    const launchInfo = buildCodexLaunchInfo(params.settings, options.codexHome)
    const lastMessagePath = path.join(
      stateDir,
      "tmp",
      `${params.agent.id}-${randomUUID()}.md`
    )
    await ensureDirectory(path.dirname(lastMessagePath))

    const result = await executeCommand({
      command: launchInfo.binaryPath,
      args: buildCodexExecArgs({
        agent: params.agent,
        projectPath: params.projectPath,
        prompt: params.prompt,
        lastMessagePath
      }),
      cwd: params.projectPath,
      env: {
        ...process.env,
        CODEX_HOME: launchInfo.homePath
      },
      stdin: params.prompt,
      timeoutMs: params.timeoutSec * 1_000
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
    }
  }

  async function runClaudeAgent(params: {
    agent: AgentDefinition
    settings: HandoffSettings
    projectPath: string
    prompt: string
    timeoutSec: number
  }) {
    const launchInfo = buildClaudeLaunchInfo(params.settings, options.claudeHome)
    const result = await executeCommand({
      command: launchInfo.binaryPath,
      args: buildClaudeExecArgs({
        agent: params.agent,
        prompt: params.prompt,
        settingsPath: launchInfo.settingsPath
      }),
      cwd: params.projectPath,
      env: process.env,
      timeoutMs: params.timeoutSec * 1_000
    })

    return {
      ...result,
      answer: parseClaudeAnswer(result.stdout)
    }
  }

  return {
    async getStatus() {
      return {
        status: "ready",
        message: "Stateless stdio agent bridge is available.",
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

    async askAgent(params) {
      const message = params.message.trim()
      if (!message) {
        throw new AgentBridgeInputError("invalid_message", "Message is required.")
      }

      await ensureProjectPath(params.projectPath)
      const timeoutSec = normalizeTimeoutSec(params.timeoutSec)
      const settings = await getSettings()
      const agent = resolveAgentByIdentity(settings.agents, params)

      if (!agent) {
        throw new AgentBridgeInputError(
          "invalid_agent",
          "Agent not found. Provide a valid agentId or exact agent name."
        )
      }

      const prompt = buildAgentPrompt({
        agent,
        message,
        context: params.context?.trim() ? params.context.trim() : null
      })
      const startedAt = new Date().toISOString()
      const runId = randomUUID()
      const baseRecord: AgentRunRecord = {
        runId,
        agentId: agent.id,
        agentName: agent.name,
        status: "running",
        provider: agent.provider,
        modelId: agent.modelId,
        thinkingLevel: agent.thinkingLevel,
        fast: agent.fast,
        projectPath: params.projectPath,
        message,
        context: params.context?.trim() ? params.context.trim() : null,
        caller: normalizeCallerMetadata(params.caller),
        prompt,
        answer: null,
        error: null,
        stdout: null,
        stderr: null,
        exitCode: null,
        startedAt,
        finishedAt: null
      }

      const lockPath = await acquireAgentLock({
        locksDir,
        agentId: agent.id,
        info: {
          runId,
          startedAt
        },
        runsLogPath
      })

      await appendRunEvent(runsLogPath, {
        event: "started",
        at: startedAt,
        record: baseRecord
      })

      try {
        const result =
          agent.provider === "codex"
            ? await runCodexAgent({
                agent,
                settings,
                projectPath: params.projectPath,
                prompt,
                timeoutSec
              })
            : await runClaudeAgent({
                agent,
                settings,
                projectPath: params.projectPath,
                prompt,
                timeoutSec
              })

        const finishedAt = new Date().toISOString()

        if (result.timedOut) {
          const failureRecord: AgentRunEvent["record"] = {
            runId,
            agentId: agent.id,
            status: "failed",
            finishedAt,
            answer: result.answer,
            error: `Timed out after ${timeoutSec} seconds.`,
            stdout: result.stdout || null,
            stderr: result.stderr || null,
            exitCode: result.exitCode
          }

          await appendRunEvent(runsLogPath, {
            event: "failed",
            at: finishedAt,
            record: failureRecord
          })

          throw new Error(failureRecord.error ?? "Provider timed out.")
        }

        if (result.exitCode !== 0) {
          const errorText =
            result.stderr.trim() ||
            result.stdout.trim() ||
            `Provider command exited with code ${result.exitCode}.`
          const failureRecord: AgentRunEvent["record"] = {
            runId,
            agentId: agent.id,
            status: "failed",
            finishedAt,
            answer: result.answer,
            error: errorText,
            stdout: result.stdout || null,
            stderr: result.stderr || null,
            exitCode: result.exitCode
          }

          await appendRunEvent(runsLogPath, {
            event: "failed",
            at: finishedAt,
            record: failureRecord
          })

          throw new Error(errorText)
        }

        if (!result.answer) {
          const failureRecord: AgentRunEvent["record"] = {
            runId,
            agentId: agent.id,
            status: "failed",
            finishedAt,
            error: "Provider command completed without a final answer.",
            stdout: result.stdout || null,
            stderr: result.stderr || null,
            exitCode: result.exitCode
          }

          await appendRunEvent(runsLogPath, {
            event: "failed",
            at: finishedAt,
            record: failureRecord
          })

          throw new Error(failureRecord.error ?? "Provider completed without a final answer.")
        }

        const completedRecord: AgentRunEvent["record"] = {
          runId,
          agentId: agent.id,
          status: "completed",
          finishedAt,
          answer: result.answer,
          stdout: result.stdout || null,
          stderr: result.stderr || null,
          exitCode: result.exitCode
        }

        await appendRunEvent(runsLogPath, {
          event: "completed",
          at: finishedAt,
          record: completedRecord
        })

        return {
          runId,
          status: "completed",
          answer: result.answer,
          agentId: agent.id,
          provider: agent.provider,
          modelId: agent.modelId,
          thinkingLevel: agent.thinkingLevel,
          fast: agent.fast,
          projectPath: params.projectPath,
          startedAt,
          finishedAt
        }
      } catch (error) {
        if (error instanceof AgentBridgeBusyError || error instanceof AgentBridgeInputError) {
          throw error
        }

        const finishedAt = new Date().toISOString()
        const failureMessage =
          error instanceof Error ? error.message : "Provider execution failed."
        const runs = await readRunRecords(runsLogPath)
        const existingRun = runs.find(run => run.runId === runId)

        if (!existingRun || existingRun.status === "running") {
          await appendRunEvent(runsLogPath, {
            event: "failed",
            at: finishedAt,
            record: {
              runId,
              agentId: agent.id,
              status: "failed",
              finishedAt,
              error: failureMessage
            }
          })
        }

        throw error
      } finally {
        await releaseAgentLock(lockPath)
      }
    },

    async listRuns(agentId, limit = 50) {
      const allRuns = await readRunRecords(runsLogPath)
      const filteredRuns = agentId
        ? allRuns.filter(run => run.agentId === agentId)
        : allRuns

      return filteredRuns.slice(0, Math.max(limit, 0))
    },

    async getRun(runId) {
      return (await readRunRecords(runsLogPath)).find(run => run.runId === runId) ?? null
    }
  }
}
