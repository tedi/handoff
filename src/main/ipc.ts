import { clipboard, nativeImage, shell, type IpcMain } from "electron"
import { execFile } from "node:child_process"
import fs from "node:fs"
import { promisify } from "node:util"

import { IPC_CHANNELS } from "../shared/channels"
import type {
  ProjectLocationTarget,
  SearchFilters,
  SessionClient,
  SessionProvider,
  TranscriptOptions
} from "../shared/contracts"
import type { HandoffService } from "./service"

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

function shellEscape(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function appleScriptEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
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

async function openCodexCliSession(sessionId: string, sessionCwd?: string | null) {
  const segments = [
    sessionCwd ? `cd ${shellEscape(sessionCwd)}` : null,
    `codex resume ${shellEscape(sessionId)}`
  ].filter((segment): segment is string => segment !== null)

  const command = segments.join(" && ")
  const script = [
    'tell application "Terminal"',
    "activate",
    `do script "${appleScriptEscape(command)}"`,
    "end tell"
  ].join("\n")

  await execFileAsync("osascript", ["-e", script])
}

async function openClaudeCliSession(sessionId: string, workingDirectory?: string | null) {
  const segments = [
    workingDirectory ? `cd ${shellEscape(workingDirectory)}` : null,
    `claude -r ${shellEscape(sessionId)}`
  ].filter((segment): segment is string => segment !== null)

  const command = segments.join(" && ")
  const script = [
    'tell application "Terminal"',
    "activate",
    `do script "${appleScriptEscape(command)}"`,
    "end tell"
  ].join("\n")

  await execFileAsync("osascript", ["-e", script])
}

async function openProjectInTerminal(projectPath: string) {
  ensureProjectPathExists(projectPath)
  const command = `cd ${shellEscape(projectPath)}`

  const script = [
    'tell application "Terminal"',
    "activate",
    `do script "${appleScriptEscape(command)}"`,
    "end tell"
  ].join("\n")

  await execFileAsync("osascript", ["-e", script])
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

async function openProjectPath(target: ProjectLocationTarget, projectPath: string) {
  if (target === "terminal") {
    await openProjectInTerminal(projectPath)
    return
  }

  if (target === "editor") {
    await openProjectInEditor(projectPath)
    return
  }

  await openProjectInFinder(projectPath)
}

export function registerIpcHandlers(ipcMain: IpcMain, service: HandoffService) {
  ipcMain.handle(IPC_CHANNELS.app.getStateInfo, async () => ({
    ...(await service.app.getStateInfo()),
    codexIconDataUrl: getCodexIconDataUrl(),
    claudeIconDataUrl: getClaudeIconDataUrl()
  }))
  ipcMain.handle(IPC_CHANNELS.app.refresh, () => service.app.refresh())
  ipcMain.handle(
    IPC_CHANNELS.app.openSourceSession,
    async (
      _event,
      provider: SessionProvider,
      sessionId: string,
      sessionClient: SessionClient = "desktop",
      workingDirectory: string | null = null
    ) => {
      if (provider === "claude") {
        await openClaudeCliSession(sessionId, workingDirectory)
        return
      }

      if (sessionClient === "cli") {
        await openCodexCliSession(sessionId, workingDirectory)
        return
      }

      await shell.openExternal(`codex://threads/${encodeURIComponent(sessionId)}`)
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.app.openProjectPath,
    (_event, target: ProjectLocationTarget, projectPath: string) =>
      openProjectPath(target, projectPath)
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
    ipcMain.removeHandler(IPC_CHANNELS.app.openSourceSession)
    ipcMain.removeHandler(IPC_CHANNELS.app.openProjectPath)
    ipcMain.removeHandler(IPC_CHANNELS.sessions.list)
    ipcMain.removeHandler(IPC_CHANNELS.sessions.getTranscript)
    ipcMain.removeHandler(IPC_CHANNELS.search.getStatus)
    ipcMain.removeHandler(IPC_CHANNELS.search.query)
    ipcMain.removeHandler(IPC_CHANNELS.clipboard.writeText)
  }
}
