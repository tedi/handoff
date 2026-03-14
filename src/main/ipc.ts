import { clipboard, nativeImage, shell, type IpcMain } from "electron"
import fs from "node:fs"

import { IPC_CHANNELS } from "../shared/channels"
import type { TranscriptOptions } from "../shared/contracts"
import type { HandoffService } from "./service"

const CODEX_ICON_PATH = "/Applications/Codex.app/Contents/Resources/electron.icns"

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

export function registerIpcHandlers(ipcMain: IpcMain, service: HandoffService) {
  ipcMain.handle(IPC_CHANNELS.app.getStateInfo, async () => ({
    ...(await service.app.getStateInfo()),
    codexIconDataUrl: getCodexIconDataUrl()
  }))
  ipcMain.handle(IPC_CHANNELS.app.refresh, () => service.app.refresh())
  ipcMain.handle(IPC_CHANNELS.app.openCodexThread, async (_event, sessionId: string) => {
    await shell.openExternal(`codex://threads/${encodeURIComponent(sessionId)}`)
  })
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
