import { clipboard, nativeImage, shell, type IpcMain } from "electron"
import { execFile } from "node:child_process"
import fs from "node:fs"
import { promisify } from "node:util"
import type { SelectorGitDiffMode } from "selector"

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
  TerminalAppId,
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
  focusExistingGhosttyThread,
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

interface RegisterIpcHandlersOptions {
  closeControlCenterPopout?(): Promise<void> | void
  openControlCenterPopout?(): Promise<void> | void
}

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
  preferredTerminalId?: TerminalAppId | null
}): Promise<OpenActionResult> {
  const terminalId =
    params.preferredTerminalId ??
    getSelectedTerminalId(params.settingsSnapshot)
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
  preferredTerminalId?: TerminalAppId | null
}): Promise<OpenActionResult> {
  const terminalId =
    params.preferredTerminalId ??
    getSelectedTerminalId(params.settingsSnapshot)
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

function getTerminalIdForHostLabel(hostAppLabel: string | null) {
  if (hostAppLabel === "Ghostty") {
    return "ghostty" as const
  }

  if (hostAppLabel === "Warp") {
    return "warp" as const
  }

  if (hostAppLabel === "Terminal") {
    return "terminal" as const
  }

  return null
}

async function openControlCenterThread(params: {
  service: HandoffService
  threadId: string
}): Promise<OpenActionResult> {
  const record = await params.service.controlCenter.getRecord(params.threadId)
  if (!record) {
    throw new Error(`Unknown live thread "${params.threadId}".`)
  }

  const settingsSnapshot = await params.service.settings.get()
  const exactTerminalId =
    record.hostAppExact ? getTerminalIdForHostLabel(record.hostAppLabel) : null

  let result: OpenActionResult

  if (record.launchMode === "cli" && exactTerminalId === "ghostty") {
    const focusedExistingThread = await focusExistingGhosttyThread({
      sessionId: record.sourceSessionId,
      threadName: record.threadName,
      projectPath: record.projectPath
    })

    if (focusedExistingThread) {
      await params.service.controlCenter.acknowledge(params.threadId)
      return { fallbackMessage: null }
    }
  }

  if (record.provider === "codex") {
    if (record.launchMode === "app") {
      await shell.openExternal(`codex://threads/${encodeURIComponent(record.sourceSessionId)}`)
      result = { fallbackMessage: null }
    } else {
      result = await openCodexCliSession({
        settingsSnapshot,
        sessionId: record.sourceSessionId,
        sessionCwd: record.projectPath,
        preferredTerminalId: exactTerminalId
      })
    }
  } else {
    result = await openClaudeCliSession({
      settingsSnapshot,
      sessionId: record.sourceSessionId,
      workingDirectory: record.projectPath,
      preferredTerminalId: exactTerminalId
    })
  }

  await params.service.controlCenter.acknowledge(params.threadId)
  return result
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

export function registerIpcHandlers(
  ipcMain: IpcMain,
  service: HandoffService,
  options: RegisterIpcHandlersOptions = {}
) {
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
  ipcMain.handle(IPC_CHANNELS.threads.get, () => service.threads.get())
  ipcMain.handle(IPC_CHANNELS.threads.update, (_event, settings) =>
    service.threads.update(settings)
  )
  ipcMain.handle(IPC_CHANNELS.controlCenter.getSnapshot, () =>
    service.controlCenter.getSnapshot()
  )
  ipcMain.handle(IPC_CHANNELS.controlCenter.dismiss, (_event, threadId: string) =>
    service.controlCenter.dismiss(threadId)
  )
  ipcMain.handle(IPC_CHANNELS.controlCenter.dismissCompleted, () =>
    service.controlCenter.dismissCompleted()
  )
  ipcMain.handle(IPC_CHANNELS.controlCenter.open, (_event, threadId: string) =>
    openControlCenterThread({
      service,
      threadId
    })
  )
  ipcMain.handle(IPC_CHANNELS.bridge.getStatus, () => service.bridge.getStatus())
  ipcMain.handle(IPC_CHANNELS.bridge.getConfigSnippets, () =>
    service.bridge.getConfigSnippets()
  )
  ipcMain.handle(
    IPC_CHANNELS.bridge.listRuns,
    (_event, agentId?: string, limit?: number) => service.bridge.listRuns(agentId, limit)
  )
  ipcMain.handle(IPC_CHANNELS.bridge.getRun, (_event, runId: string) =>
    service.bridge.getRun(runId)
  )
  ipcMain.handle(IPC_CHANNELS.bridge.cancelRun, (_event, runId: string) =>
    service.bridge.cancelRun(runId)
  )
  ipcMain.handle(IPC_CHANNELS.skills.getStatus, () => service.skills.getStatus())
  ipcMain.handle(
    IPC_CHANNELS.skills.install,
    (_event, target: import("../shared/contracts").SkillInstallTarget) =>
      service.skills.install(target)
  )
  ipcMain.handle(IPC_CHANNELS.skills.exportPackage, () => service.skills.exportPackage())
  ipcMain.handle(
    IPC_CHANNELS.skills.copySetupInstructions,
    async (_event, target: import("../shared/contracts").SkillInstallTarget) => {
      clipboard.writeText(await service.skills.getSetupInstructions(target))
      return { copied: true }
    }
  )
  ipcMain.handle(IPC_CHANNELS.selector.app.getStateInfo, () =>
    service.selector.app.getStateInfo()
  )
  ipcMain.handle(IPC_CHANNELS.selector.app.openPath, (_event, filePath: string) =>
    service.selector.app.openPath(filePath)
  )
  ipcMain.handle(IPC_CHANNELS.selector.app.refresh, () =>
    service.selector.app.refresh()
  )
  ipcMain.handle(IPC_CHANNELS.selector.roots.list, () => service.selector.roots.list())
  ipcMain.handle(
    IPC_CHANNELS.selector.git.diffStats,
    (_event, paths: string[]) => service.selector.git.diffStats(paths)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.git.status,
    (_event, paths: string[]) => service.selector.git.status(paths)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.list,
    () => service.selector.manifests.list()
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.get,
    (_event, name: string) => service.selector.manifests.get(name)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.addFiles,
    (_event, name: string, paths: string[]) =>
      service.selector.manifests.addFiles(name, paths)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.duplicate,
    (_event, name: string, nextName: string) =>
      service.selector.manifests.duplicate(name, nextName)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.deleteBundle,
    (_event, name: string) => service.selector.manifests.deleteBundle(name)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.rename,
    (_event, name: string, nextName: string) =>
      service.selector.manifests.rename(name, nextName)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.setComment,
    (_event, name: string, filePath: string, comment: string) =>
      service.selector.manifests.setComment(name, filePath, comment)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.setExportText,
    (
      _event,
      name: string,
      exportPrefixText: string,
      exportSuffixText: string,
      stripComments?: boolean,
      gitDiffModeOrUseGitDiffs?: SelectorGitDiffMode | boolean
    ) =>
      service.selector.manifests.setExportText(
        name,
        exportPrefixText,
        exportSuffixText,
        stripComments,
        gitDiffModeOrUseGitDiffs
      )
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.setSelected,
    (_event, name: string, filePath: string, selected: boolean) =>
      service.selector.manifests.setSelected(name, filePath, selected)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.setSelectedPaths,
    (_event, name: string, paths: string[]) =>
      service.selector.manifests.setSelectedPaths(name, paths)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.manifests.removeFiles,
    (_event, name: string, paths: string[]) =>
      service.selector.manifests.removeFiles(name, paths)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.files.search,
    (_event, rootId: string, query: string, limit?: number) =>
      service.selector.files.search(rootId, query, limit)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.files.preview,
    (_event, filePath: string) => service.selector.files.preview(filePath)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.exports.estimate,
    (_event, name: string) => service.selector.exports.estimate(name)
  )
  ipcMain.handle(
    IPC_CHANNELS.selector.exports.regenerateAndCopy,
    (_event, name: string) => service.selector.exports.regenerateAndCopy(name)
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
  ipcMain.handle(IPC_CHANNELS.app.openControlCenterPopout, async () => {
    await options.openControlCenterPopout?.()
  })
  ipcMain.handle(IPC_CHANNELS.app.closeControlCenterPopout, async () => {
    await options.closeControlCenterPopout?.()
  })
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
    ipcMain.removeHandler(IPC_CHANNELS.threads.get)
    ipcMain.removeHandler(IPC_CHANNELS.threads.update)
    ipcMain.removeHandler(IPC_CHANNELS.controlCenter.getSnapshot)
    ipcMain.removeHandler(IPC_CHANNELS.controlCenter.dismiss)
    ipcMain.removeHandler(IPC_CHANNELS.controlCenter.dismissCompleted)
    ipcMain.removeHandler(IPC_CHANNELS.controlCenter.open)
    ipcMain.removeHandler(IPC_CHANNELS.selector.app.getStateInfo)
    ipcMain.removeHandler(IPC_CHANNELS.selector.app.openPath)
    ipcMain.removeHandler(IPC_CHANNELS.selector.app.refresh)
    ipcMain.removeHandler(IPC_CHANNELS.selector.roots.list)
    ipcMain.removeHandler(IPC_CHANNELS.selector.git.diffStats)
    ipcMain.removeHandler(IPC_CHANNELS.selector.git.status)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.list)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.get)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.addFiles)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.duplicate)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.deleteBundle)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.rename)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.setComment)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.setExportText)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.setSelected)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.setSelectedPaths)
    ipcMain.removeHandler(IPC_CHANNELS.selector.manifests.removeFiles)
    ipcMain.removeHandler(IPC_CHANNELS.selector.files.search)
    ipcMain.removeHandler(IPC_CHANNELS.selector.files.preview)
    ipcMain.removeHandler(IPC_CHANNELS.selector.exports.estimate)
    ipcMain.removeHandler(IPC_CHANNELS.selector.exports.regenerateAndCopy)
    ipcMain.removeHandler(IPC_CHANNELS.app.openSourceSession)
    ipcMain.removeHandler(IPC_CHANNELS.app.openProjectPath)
    ipcMain.removeHandler(IPC_CHANNELS.app.openControlCenterPopout)
    ipcMain.removeHandler(IPC_CHANNELS.app.closeControlCenterPopout)
    ipcMain.removeHandler(IPC_CHANNELS.app.startNewThread)
    ipcMain.removeHandler(IPC_CHANNELS.sessions.list)
    ipcMain.removeHandler(IPC_CHANNELS.sessions.getTranscript)
    ipcMain.removeHandler(IPC_CHANNELS.search.getStatus)
    ipcMain.removeHandler(IPC_CHANNELS.search.query)
    ipcMain.removeHandler(IPC_CHANNELS.clipboard.writeText)
  }
}
