import { clipboard, nativeImage, shell, type IpcMain } from "electron"
import { execFile } from "node:child_process"
import fs from "node:fs"
import { promisify } from "node:util"

import { IPC_CHANNELS } from "../shared/channels"
import type { SessionClient, TranscriptOptions } from "../shared/contracts"
import type { HandoffService } from "./service"

const CODEX_ICON_PATH = "/Applications/Codex.app/Contents/Resources/electron.icns"
const execFileAsync = promisify(execFile)

let cachedCodexIconDataUrl: string | null | undefined

function getCodexIconDataUrl() {
  if (cachedCodexIconDataUrl !== undefined) {
    return cachedCodexIconDataUrl
  }

  if (!fs.existsSync(CODEX_ICON_PATH)) {
    cachedCodexIconDataUrl = null
    return cachedCodexIconDataUrl
  }

  const icon = nativeImage.createFromPath(CODEX_ICON_PATH)
  if (icon.isEmpty()) {
    cachedCodexIconDataUrl = null
    return cachedCodexIconDataUrl
  }

  cachedCodexIconDataUrl = icon.resize({ width: 18, height: 18 }).toDataURL()
  return cachedCodexIconDataUrl
}

function shellEscape(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function appleScriptEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
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

export function registerIpcHandlers(ipcMain: IpcMain, service: HandoffService) {
  ipcMain.handle(IPC_CHANNELS.app.getStateInfo, async () => ({
    ...(await service.app.getStateInfo()),
    codexIconDataUrl: getCodexIconDataUrl()
  }))
  ipcMain.handle(IPC_CHANNELS.app.refresh, () => service.app.refresh())
  ipcMain.handle(
    IPC_CHANNELS.app.openCodexThread,
    async (
      _event,
      sessionId: string,
      sessionClient: SessionClient = "desktop",
      sessionCwd: string | null = null
    ) => {
      if (sessionClient === "cli") {
        await openCodexCliSession(sessionId, sessionCwd)
        return
      }

      await shell.openExternal(`codex://threads/${encodeURIComponent(sessionId)}`)
    }
  )
  ipcMain.handle(IPC_CHANNELS.sessions.list, () => service.sessions.list())
  ipcMain.handle(
    IPC_CHANNELS.sessions.getTranscript,
    (_event, id: string, options: TranscriptOptions) =>
      service.sessions.getTranscript(id, options)
  )
  ipcMain.handle(IPC_CHANNELS.clipboard.writeText, (_event, text: string) => {
    clipboard.writeText(text)
    return { copied: true as const }
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.app.getStateInfo)
    ipcMain.removeHandler(IPC_CHANNELS.app.refresh)
    ipcMain.removeHandler(IPC_CHANNELS.app.openCodexThread)
    ipcMain.removeHandler(IPC_CHANNELS.sessions.list)
    ipcMain.removeHandler(IPC_CHANNELS.sessions.getTranscript)
    ipcMain.removeHandler(IPC_CHANNELS.clipboard.writeText)
  }
}
