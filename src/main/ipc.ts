import { clipboard, nativeImage, shell, type IpcMain } from "electron"
import { execFile } from "node:child_process"
import fs from "node:fs"
import { promisify } from "node:util"

import { IPC_CHANNELS } from "../shared/channels"
import type {
  AgentUpdatePatch,
  HandoffSettingsSnapshot,
  NewThreadLaunchParams,
  NewThreadLaunchResult,
  OpenActionResult,
  ProjectLocationTarget,
  SearchFilters,
  SessionClient,
  SessionProvider,
  ThinkingLevel,
  TranscriptOptions
} from "../shared/contracts"
import {
  getComposerProviderConfig,
  normalizeComposerTarget
} from "../shared/provider-config"
import type { HandoffService } from "./service"
import {
  buildClaudeStartCommand,
  buildClaudeResumeCommand,
  buildCodexStartCommand,
  buildCodexResumeCommand,
  openProjectInTerminal,
  openShellCommandInTerminal
} from "./terminal"

const CODEX_ICON_PATH = "/Applications/Codex.app/Contents/Resources/electron.icns"
const CLAUDE_ICON_PATH = "/Applications/Claude.app/Contents/Resources/electron.icns"
const EDITOR_APP_CANDIDATES = [
  {
    appName: "Cursor",
    appPath: "/Applications/Cursor.app",
    aliases: ["cursor"]
  },
  {
    appName: "Visual Studio Code",
    appPath: "/Applications/Visual Studio Code.app",
    aliases: ["code", "vscode", "visual studio code"]
  },
  {
    appName: "Zed",
    appPath: "/Applications/Zed.app",
    aliases: ["zed"]
  }
] as const
const execFileAsync = promisify(execFile)
const DIRECT_PROMPT_BYTE_LIMIT = 8_000

let cachedCodexIconDataUrl: string | null | undefined
let cachedClaudeIconDataUrl: string | null | undefined

function getAppIconDataUrl(params: {
  iconPath: string
  size?: number
  cacheValue: string | null | undefined
  setCacheValue(value: string | null): void
}) {
  if (params.cacheValue !== undefined) {
    return params.cacheValue
  }

  if (!fs.existsSync(params.iconPath)) {
    params.setCacheValue(null)
    return null
  }

  const icon = nativeImage.createFromPath(params.iconPath)
  if (icon.isEmpty()) {
    params.setCacheValue(null)
    return null
  }

  const nextValue = icon
    .resize({ width: params.size ?? 18, height: params.size ?? 18 })
    .toDataURL()
  params.setCacheValue(nextValue)
  return nextValue
}

function getCodexIconDataUrl() {
  return getAppIconDataUrl({
    iconPath: CODEX_ICON_PATH,
    cacheValue: cachedCodexIconDataUrl,
    setCacheValue(value) {
      cachedCodexIconDataUrl = value
    }
  })
}

function getClaudeIconDataUrl() {
  return getAppIconDataUrl({
    iconPath: CLAUDE_ICON_PATH,
    cacheValue: cachedClaudeIconDataUrl,
    setCacheValue(value) {
      cachedClaudeIconDataUrl = value
    }
  })
}

function ensureProjectPathExists(projectPath: string) {
  if (!fs.existsSync(projectPath)) {
    throw new Error(`Project path not found: ${projectPath}`)
  }
}

function normalizeEditorAppName(value: string) {
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return null
  }

  if (trimmedValue.endsWith(".app")) {
    return fs.existsSync(trimmedValue)
      ? trimmedValue.replace(/^.*\//, "").replace(/\.app$/, "")
      : null
  }

  const normalizedValue = trimmedValue.toLowerCase()
  const match = EDITOR_APP_CANDIDATES.find(candidate => {
    return (
      candidate.appName.toLowerCase() === normalizedValue ||
      candidate.aliases.some(alias => normalizedValue.includes(alias))
    )
  })

  if (match && fs.existsSync(match.appPath)) {
    return match.appName
  }

  return null
}

function resolveEditorAppName() {
  const explicitEditor = [
    process.env.HANDOFF_EDITOR_APP,
    process.env.VISUAL,
    process.env.EDITOR
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeEditorAppName)
    .find((value): value is string => Boolean(value))

  if (explicitEditor) {
    return explicitEditor
  }

  const installedEditor = EDITOR_APP_CANDIDATES.find(candidate =>
    fs.existsSync(candidate.appPath)
  )

  return installedEditor?.appName ?? null
}

async function openProjectInFinder(projectPath: string) {
  ensureProjectPathExists(projectPath)

  const result = await shell.openPath(projectPath)
  if (result) {
    throw new Error(result)
  }
}

async function openProjectInEditor(projectPath: string) {
  ensureProjectPathExists(projectPath)

  const editorAppName = resolveEditorAppName()
  if (!editorAppName) {
    throw new Error(
      "No supported editor found. Install Cursor, Visual Studio Code, or Zed, or set HANDOFF_EDITOR_APP."
    )
  }

  await execFileAsync("open", ["-a", editorAppName, projectPath])
}

function getSelectedTerminalId(settingsSnapshot: HandoffSettingsSnapshot) {
  return settingsSnapshot.settings.terminals.defaultTerminalId
}

function getCodexLaunchInfo(settingsSnapshot: HandoffSettingsSnapshot) {
  const providerInfo = settingsSnapshot.providerInfo.codex
  return {
    binaryPath: providerInfo.effectiveBinaryPath,
    homePath: providerInfo.effectiveHomePath
  }
}

function getClaudeLaunchInfo(settingsSnapshot: HandoffSettingsSnapshot) {
  const providerInfo = settingsSnapshot.providerInfo.claude
  const settingsPath = providerInfo.configExists ? providerInfo.configPath : null

  return {
    binaryPath: providerInfo.effectiveBinaryPath,
    settingsPath
  }
}

function mapThinkingLevelToCodexEffort(thinkingLevel: ThinkingLevel) {
  if (thinkingLevel === "max") {
    return "xhigh"
  }

  return thinkingLevel
}

function mapThinkingLevelToClaudeEffort(thinkingLevel: ThinkingLevel) {
  return thinkingLevel
}

async function openCodexCliSession(params: {
  settingsSnapshot: HandoffSettingsSnapshot
  sessionId: string
  sessionCwd?: string | null
}): Promise<OpenActionResult> {
  const terminalId = getSelectedTerminalId(params.settingsSnapshot)
  const launchInfo = getCodexLaunchInfo(params.settingsSnapshot)

  return openShellCommandInTerminal({
    preferredTerminalId: terminalId,
    command: buildCodexResumeCommand({
      sessionId: params.sessionId,
      sessionCwd: params.sessionCwd,
      binaryPath: launchInfo.binaryPath,
      homePath: launchInfo.homePath
    })
  })
}

async function openClaudeCliSession(params: {
  settingsSnapshot: HandoffSettingsSnapshot
  sessionId: string
  workingDirectory?: string | null
}): Promise<OpenActionResult> {
  const terminalId = getSelectedTerminalId(params.settingsSnapshot)
  const launchInfo = getClaudeLaunchInfo(params.settingsSnapshot)

  return openShellCommandInTerminal({
    preferredTerminalId: terminalId,
    command: buildClaudeResumeCommand({
      sessionId: params.sessionId,
      workingDirectory: params.workingDirectory,
      binaryPath: launchInfo.binaryPath,
      settingsPath: launchInfo.settingsPath
    })
  })
}

async function openProjectPath(
  settingsSnapshot: HandoffSettingsSnapshot,
  target: ProjectLocationTarget,
  projectPath: string
) {
  if (target === "terminal") {
    ensureProjectPathExists(projectPath)
    return openProjectInTerminal({
      preferredTerminalId: getSelectedTerminalId(settingsSnapshot),
      projectPath
    })
  }

  if (target === "editor") {
    await openProjectInEditor(projectPath)
    return { fallbackMessage: null }
  }

  await openProjectInFinder(projectPath)
  return { fallbackMessage: null }
}

async function openCodexAppProject(params: {
  settingsSnapshot: HandoffSettingsSnapshot
  projectPath: string
}) {
  ensureProjectPathExists(params.projectPath)
  const launchInfo = getCodexLaunchInfo(params.settingsSnapshot)

  await execFileAsync(launchInfo.binaryPath, ["app", params.projectPath], {
    env: {
      ...process.env,
      CODEX_HOME: launchInfo.homePath
    }
  })
}

async function startNewThread(
  settingsSnapshot: HandoffSettingsSnapshot,
  params: NewThreadLaunchParams
): Promise<NewThreadLaunchResult> {
  if (!params.projectPath.trim()) {
    throw new Error("A project path is required to start a thread.")
  }

  if (!params.prompt.trim()) {
    throw new Error("A prompt is required to start a thread.")
  }

  const normalizedTarget = normalizeComposerTarget({
    provider: params.provider,
    launchMode: params.launchMode,
    modelId: params.modelId,
    fast: params.fast
  })
  const providerConfig = getComposerProviderConfig(params.provider)

  if (params.provider === "claude" && normalizedTarget.launchMode !== "cli") {
    throw new Error("Claude starts only support Claude Code.")
  }

  if (params.launchMode === "app") {
    if (!providerConfig.launchModes.includes("app")) {
      throw new Error(`${providerConfig.label} does not support app launches.`)
    }

    clipboard.writeText(params.prompt)

    if (params.provider === "codex") {
      await openCodexAppProject({
        settingsSnapshot,
        projectPath: params.projectPath
      })
    }

    return {
      launchMode: "app",
      copiedPrompt: true,
      fallbackMessage: null
    }
  }

  const promptByteLength = Buffer.byteLength(params.prompt, "utf8")
  const shouldFallbackToCopiedPrompt = promptByteLength > DIRECT_PROMPT_BYTE_LIMIT

  if (params.provider === "codex") {
    const terminalId = getSelectedTerminalId(settingsSnapshot)
    const launchInfo = getCodexLaunchInfo(settingsSnapshot)
    const command = buildCodexStartCommand({
      projectPath: params.projectPath,
      prompt: shouldFallbackToCopiedPrompt ? "" : params.prompt,
      binaryPath: launchInfo.binaryPath,
      homePath: launchInfo.homePath,
      modelId: normalizedTarget.modelId,
      reasoningEffort: mapThinkingLevelToCodexEffort(params.thinkingLevel),
      serviceTier: normalizedTarget.fast ? "fast" : null
    })

    if (shouldFallbackToCopiedPrompt) {
      clipboard.writeText(params.prompt)
    }

    const result = await openShellCommandInTerminal({
      preferredTerminalId: terminalId,
      command
    })

    return {
      launchMode: "cli",
      copiedPrompt: shouldFallbackToCopiedPrompt,
      fallbackMessage: [
        result.fallbackMessage,
        shouldFallbackToCopiedPrompt
          ? "Prompt copied to clipboard and Codex was opened without an initial prompt because it exceeded the direct launch limit."
          : null
      ]
        .filter(Boolean)
        .join(" ")
        .trim() || null
    }
  }

  const terminalId = getSelectedTerminalId(settingsSnapshot)
  const launchInfo = getClaudeLaunchInfo(settingsSnapshot)
  const command = buildClaudeStartCommand({
    projectPath: params.projectPath,
    prompt: shouldFallbackToCopiedPrompt ? "" : params.prompt,
    binaryPath: launchInfo.binaryPath,
    settingsPath: launchInfo.settingsPath,
    modelId: normalizedTarget.modelId,
    effortLevel: mapThinkingLevelToClaudeEffort(params.thinkingLevel)
  })

  if (shouldFallbackToCopiedPrompt) {
    clipboard.writeText(params.prompt)
  }

  const result = await openShellCommandInTerminal({
    preferredTerminalId: terminalId,
    command
  })

  return {
    launchMode: "cli",
    copiedPrompt: shouldFallbackToCopiedPrompt,
    fallbackMessage: [
      result.fallbackMessage,
      shouldFallbackToCopiedPrompt
        ? "Prompt copied to clipboard and Claude was opened without an initial prompt because it exceeded the direct launch limit."
        : null
    ]
      .filter(Boolean)
      .join(" ")
      .trim() || null
  }
}

export function registerIpcHandlers(ipcMain: IpcMain, service: HandoffService) {
  ipcMain.handle(IPC_CHANNELS.app.getStateInfo, async () => ({
    ...(await service.app.getStateInfo()),
    codexIconDataUrl: getCodexIconDataUrl(),
    claudeIconDataUrl: getClaudeIconDataUrl()
  }))
  ipcMain.handle(IPC_CHANNELS.app.refresh, () => service.app.refresh())
  ipcMain.handle(IPC_CHANNELS.settings.get, () => service.settings.get())
  ipcMain.handle(
    IPC_CHANNELS.settings.update,
    (_event, patch) => service.settings.update(patch)
  )
  ipcMain.handle(
    IPC_CHANNELS.settings.resetProvider,
    (_event, provider: SessionProvider) => service.settings.resetProvider(provider)
  )
  ipcMain.handle(IPC_CHANNELS.agents.list, () => service.agents.list())
  ipcMain.handle(IPC_CHANNELS.agents.create, () => service.agents.create())
  ipcMain.handle(
    IPC_CHANNELS.agents.update,
    (_event, id: string, patch: AgentUpdatePatch) => service.agents.update(id, patch)
  )
  ipcMain.handle(IPC_CHANNELS.agents.delete, (_event, id: string) => service.agents.delete(id))
  ipcMain.handle(
    IPC_CHANNELS.agents.duplicate,
    (_event, id: string) => service.agents.duplicate(id)
  )
  ipcMain.handle(
    IPC_CHANNELS.app.openSourceSession,
    async (
      _event,
      provider: SessionProvider,
      sessionId: string,
      sessionClient: SessionClient = "desktop",
      workingDirectory: string | null = null
    ) => {
      const settingsSnapshot = await service.settings.get()

      if (provider === "claude") {
        return openClaudeCliSession({
          settingsSnapshot,
          sessionId,
          workingDirectory
        })
      }

      if (sessionClient === "cli") {
        return openCodexCliSession({
          settingsSnapshot,
          sessionId,
          sessionCwd: workingDirectory
        })
      }

      await shell.openExternal(`codex://threads/${encodeURIComponent(sessionId)}`)
      return { fallbackMessage: null }
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.app.openProjectPath,
    async (_event, target: ProjectLocationTarget, projectPath: string) =>
      openProjectPath(await service.settings.get(), target, projectPath)
  )
  ipcMain.handle(
    IPC_CHANNELS.app.startNewThread,
    async (_event, params: NewThreadLaunchParams) =>
      startNewThread(await service.settings.get(), params)
  )
  ipcMain.handle(IPC_CHANNELS.sessions.list, () => service.sessions.list())
  ipcMain.handle(
    IPC_CHANNELS.sessions.getTranscript,
    (_event, id: string, options: TranscriptOptions) =>
      service.sessions.getTranscript(id, options)
  )
  ipcMain.handle(IPC_CHANNELS.search.getStatus, () => service.search.getStatus())
  ipcMain.handle(
    IPC_CHANNELS.search.query,
    (_event, params: { query: string; filters: SearchFilters; limit: number }) =>
      service.search.query(params)
  )
  ipcMain.handle(IPC_CHANNELS.clipboard.writeText, (_event, text: string) => {
    clipboard.writeText(text)
    return { copied: true as const }
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.app.getStateInfo)
    ipcMain.removeHandler(IPC_CHANNELS.app.refresh)
    ipcMain.removeHandler(IPC_CHANNELS.settings.get)
    ipcMain.removeHandler(IPC_CHANNELS.settings.update)
    ipcMain.removeHandler(IPC_CHANNELS.settings.resetProvider)
    ipcMain.removeHandler(IPC_CHANNELS.agents.list)
    ipcMain.removeHandler(IPC_CHANNELS.agents.create)
    ipcMain.removeHandler(IPC_CHANNELS.agents.update)
    ipcMain.removeHandler(IPC_CHANNELS.agents.delete)
    ipcMain.removeHandler(IPC_CHANNELS.agents.duplicate)
    ipcMain.removeHandler(IPC_CHANNELS.app.openSourceSession)
    ipcMain.removeHandler(IPC_CHANNELS.app.openProjectPath)
    ipcMain.removeHandler(IPC_CHANNELS.app.startNewThread)
    ipcMain.removeHandler(IPC_CHANNELS.sessions.list)
    ipcMain.removeHandler(IPC_CHANNELS.sessions.getTranscript)
    ipcMain.removeHandler(IPC_CHANNELS.search.getStatus)
    ipcMain.removeHandler(IPC_CHANNELS.search.query)
    ipcMain.removeHandler(IPC_CHANNELS.clipboard.writeText)
  }
}
