import type { IpcRendererEvent } from "electron"

import { IPC_CHANNELS } from "../shared/channels"
import type {
  ClipboardWriteResult,
  HandoffSettingsPatch,
  HandoffSettingsSnapshot,
  HandoffApi,
  OpenActionResult,
  ProjectLocationTarget,
  SearchFilters,
  SearchStatus,
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
      payload: unknown
    ) => void
  ): void
  removeListener(
    channel: string,
    listener: (
      event: IpcRendererEvent | Event,
      payload: unknown
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
        ) as Promise<OpenActionResult>
      },

      openProjectPath(target: ProjectLocationTarget, projectPath: string) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.app.openProjectPath,
          target,
          projectPath
        ) as Promise<OpenActionResult>
      },

      onStateChanged(listener) {
        const wrappedListener = (_event: IpcRendererEvent | Event, payload: unknown) => {
          listener(payload as HandoffStateChangeEvent)
        }

        ipcRenderer.on(IPC_CHANNELS.stateChanged, wrappedListener)

        return () => {
          ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, wrappedListener)
        }
      }
    },

    settings: {
      get() {
        return ipcRenderer.invoke(IPC_CHANNELS.settings.get) as Promise<HandoffSettingsSnapshot>
      },

      update(patch: HandoffSettingsPatch) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.settings.update,
          patch
        ) as Promise<HandoffSettingsSnapshot>
      },

      resetProvider(provider: SessionProvider) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.settings.resetProvider,
          provider
        ) as Promise<HandoffSettingsSnapshot>
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

    search: {
      getStatus() {
        return ipcRenderer.invoke(IPC_CHANNELS.search.getStatus) as Promise<SearchStatus>
      },

      query(params: { query: string; filters: SearchFilters; limit: number }) {
        return ipcRenderer.invoke(IPC_CHANNELS.search.query, params) as Promise<
          Awaited<ReturnType<HandoffApi["search"]["query"]>>
        >
      },

      onStatusChanged(listener) {
        const wrappedListener = (_event: IpcRendererEvent | Event, payload: unknown) => {
          listener(payload as SearchStatus)
        }

        ipcRenderer.on(IPC_CHANNELS.searchStatusChanged, wrappedListener)

        return () => {
          ipcRenderer.removeListener(
            IPC_CHANNELS.searchStatusChanged,
            wrappedListener
          )
        }
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
