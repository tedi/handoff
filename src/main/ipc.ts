import { clipboard, type IpcMain } from "electron"

import { IPC_CHANNELS } from "../shared/channels"
import type { TranscriptOptions } from "../shared/contracts"
import type { HandoffService } from "./service"

export function registerIpcHandlers(ipcMain: IpcMain, service: HandoffService) {
  ipcMain.handle(IPC_CHANNELS.app.getStateInfo, () => service.app.getStateInfo())
  ipcMain.handle(IPC_CHANNELS.app.refresh, () => service.app.refresh())
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
    ipcMain.removeHandler(IPC_CHANNELS.sessions.list)
    ipcMain.removeHandler(IPC_CHANNELS.sessions.getTranscript)
    ipcMain.removeHandler(IPC_CHANNELS.clipboard.writeText)
  }
}
