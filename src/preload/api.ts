import type { IpcRendererEvent } from "electron"

import { IPC_CHANNELS } from "../shared/channels"
import type {
  ClipboardWriteResult,
  HandoffApi,
  ProjectLocationTarget,
  SessionClient,
  SessionProvider,
  HandoffStateChangeEvent,
  TranscriptOptions
} from "../shared/contracts"

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(
    channel: string,
    listener: (
      event: IpcRendererEvent | Event,
      payload: HandoffStateChangeEvent
    ) => void
  ): void
  removeListener(
    channel: string,
    listener: (
      event: IpcRendererEvent | Event,
      payload: HandoffStateChangeEvent
    ) => void
  ): void
}

export function createHandoffBridge(
  ipcRenderer: IpcRendererLike
): HandoffApi {
  return {
    app: {
      getStateInfo() {
        return ipcRenderer.invoke(IPC_CHANNELS.app.getStateInfo) as Promise<
          Awaited<ReturnType<HandoffApi["app"]["getStateInfo"]>>
        >
      },

      refresh() {
        return ipcRenderer.invoke(IPC_CHANNELS.app.refresh) as Promise<
          Awaited<ReturnType<HandoffApi["app"]["refresh"]>>
        >
      },

      openSourceSession(
        provider: SessionProvider,
        sessionId: string,
        sessionClient?: SessionClient,
        workingDirectory?: string | null
      ) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.app.openSourceSession,
          provider,
          sessionId,
          sessionClient,
          workingDirectory
        ) as Promise<void>
      },

      openProjectPath(target: ProjectLocationTarget, projectPath: string) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.app.openProjectPath,
          target,
          projectPath
        ) as Promise<void>
      },

      onStateChanged(listener) {
        const wrappedListener = (
          _event: IpcRendererEvent | Event,
          payload: HandoffStateChangeEvent
        ) => {
          listener(payload)
        }

        ipcRenderer.on(IPC_CHANNELS.stateChanged, wrappedListener)

        return () => {
          ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, wrappedListener)
        }
      }
    },

    sessions: {
      list() {
        return ipcRenderer.invoke(IPC_CHANNELS.sessions.list) as Promise<
          Awaited<ReturnType<HandoffApi["sessions"]["list"]>>
        >
      },

      getTranscript(id: string, options: TranscriptOptions) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.sessions.getTranscript,
          id,
          options
        ) as Promise<
          Awaited<ReturnType<HandoffApi["sessions"]["getTranscript"]>>
        >
      }
    },

    clipboard: {
      writeText(text: string) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.clipboard.writeText,
          text
        ) as Promise<ClipboardWriteResult>
      }
    }
  }
}
