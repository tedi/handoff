import type { IpcRendererEvent } from "electron"
import type { SelectorGitDiffMode } from "selector"

import { IPC_CHANNELS } from "../shared/channels"
import type {
  AgentUpdatePatch,
  AgentBridgeConfigSnippets,
  AgentBridgeHealth,
  AgentRunRecord,
  ClipboardWriteResult,
  ControlCenterStateChangeEvent,
  HandoffSkillsExportResult,
  HandoffSkillsStatus,
  HandoffSettingsPatch,
  HandoffSettingsSnapshot,
  HandoffApi,
  NewThreadLaunchParams,
  NewThreadLaunchResult,
  OpenActionResult,
  ProjectLocationTarget,
  SelectorAppStateChangeEvent,
  SearchFilters,
  SearchStatus,
  SessionClient,
  SessionProvider,
  SkillInstallTarget,
  HandoffStateChangeEvent,
  ThreadOrganizationSettings,
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

      startNewThread(params: NewThreadLaunchParams) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.app.startNewThread,
          params
        ) as Promise<NewThreadLaunchResult>
      },

      openProjectPath(target: ProjectLocationTarget, projectPath: string) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.app.openProjectPath,
          target,
          projectPath
        ) as Promise<OpenActionResult>
      },

      openControlCenterPopout() {
        return ipcRenderer.invoke(IPC_CHANNELS.app.openControlCenterPopout) as Promise<void>
      },

      closeControlCenterPopout() {
        return ipcRenderer.invoke(IPC_CHANNELS.app.closeControlCenterPopout) as Promise<void>
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

    agents: {
      list() {
        return ipcRenderer.invoke(IPC_CHANNELS.agents.list) as Promise<
          Awaited<ReturnType<HandoffApi["agents"]["list"]>>
        >
      },

      create() {
        return ipcRenderer.invoke(IPC_CHANNELS.agents.create) as Promise<
          Awaited<ReturnType<HandoffApi["agents"]["create"]>>
        >
      },

      update(id: string, patch: AgentUpdatePatch) {
        return ipcRenderer.invoke(IPC_CHANNELS.agents.update, id, patch) as Promise<
          Awaited<ReturnType<HandoffApi["agents"]["update"]>>
        >
      },

      delete(id: string) {
        return ipcRenderer.invoke(IPC_CHANNELS.agents.delete, id) as Promise<
          Awaited<ReturnType<HandoffApi["agents"]["delete"]>>
        >
      },

      duplicate(id: string) {
        return ipcRenderer.invoke(IPC_CHANNELS.agents.duplicate, id) as Promise<
          Awaited<ReturnType<HandoffApi["agents"]["duplicate"]>>
        >
      }
    },

    threads: {
      get() {
        return ipcRenderer.invoke(IPC_CHANNELS.threads.get) as Promise<ThreadOrganizationSettings>
      },

      update(settings: ThreadOrganizationSettings) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.threads.update,
          settings
        ) as Promise<ThreadOrganizationSettings>
      }
    },

    controlCenter: {
      getSnapshot() {
        return ipcRenderer.invoke(IPC_CHANNELS.controlCenter.getSnapshot) as Promise<
          Awaited<ReturnType<HandoffApi["controlCenter"]["getSnapshot"]>>
        >
      },

      open(threadId: string) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.controlCenter.open,
          threadId
        ) as Promise<Awaited<ReturnType<HandoffApi["controlCenter"]["open"]>>>
      },

      dismiss(threadId: string) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.controlCenter.dismiss,
          threadId
        ) as Promise<Awaited<ReturnType<HandoffApi["controlCenter"]["dismiss"]>>>
      },

      dismissCompleted() {
        return ipcRenderer.invoke(
          IPC_CHANNELS.controlCenter.dismissCompleted
        ) as Promise<Awaited<ReturnType<HandoffApi["controlCenter"]["dismissCompleted"]>>>
      },

      onStateChanged(listener) {
        const wrappedListener = (_event: IpcRendererEvent | Event, payload: unknown) => {
          listener(payload as ControlCenterStateChangeEvent)
        }

        ipcRenderer.on(IPC_CHANNELS.controlCenterStateChanged, wrappedListener)

        return () => {
          ipcRenderer.removeListener(
            IPC_CHANNELS.controlCenterStateChanged,
            wrappedListener
          )
        }
      }
    },

    bridge: {
      getStatus() {
        return ipcRenderer.invoke(IPC_CHANNELS.bridge.getStatus) as Promise<AgentBridgeHealth>
      },

      getConfigSnippets() {
        return ipcRenderer.invoke(
          IPC_CHANNELS.bridge.getConfigSnippets
        ) as Promise<AgentBridgeConfigSnippets>
      },

      listRuns(agentId?: string, limit?: number) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.bridge.listRuns,
          agentId,
          limit
        ) as Promise<AgentRunRecord[]>
      },

      getRun(runId: string) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.bridge.getRun,
          runId
        ) as Promise<AgentRunRecord | null>
      },

      cancelRun(runId: string) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.bridge.cancelRun,
          runId
        ) as Promise<AgentRunRecord | null>
      }
    },

    skills: {
      getStatus() {
        return ipcRenderer.invoke(IPC_CHANNELS.skills.getStatus) as Promise<HandoffSkillsStatus>
      },

      install(target: SkillInstallTarget) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.skills.install,
          target
        ) as Promise<HandoffSkillsStatus>
      },

      exportPackage() {
        return ipcRenderer.invoke(
          IPC_CHANNELS.skills.exportPackage
        ) as Promise<HandoffSkillsExportResult>
      },

      copySetupInstructions(target: SkillInstallTarget) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.skills.copySetupInstructions,
          target
        ) as Promise<ClipboardWriteResult>
      }
    },

    selector: {
      app: {
        getStateInfo() {
          return ipcRenderer.invoke(IPC_CHANNELS.selector.app.getStateInfo) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["app"]["getStateInfo"]>>
          >
        },

        openPath(path: string) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.app.openPath,
            path
          ) as Promise<Awaited<ReturnType<HandoffApi["selector"]["app"]["openPath"]>>>
        },

        refresh() {
          return ipcRenderer.invoke(IPC_CHANNELS.selector.app.refresh) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["app"]["refresh"]>>
          >
        },

        onStateChanged(listener) {
          const wrappedListener = (_event: IpcRendererEvent | Event, payload: unknown) => {
            listener(payload as SelectorAppStateChangeEvent)
          }

          ipcRenderer.on(IPC_CHANNELS.selectorStateChanged, wrappedListener)

          return () => {
            ipcRenderer.removeListener(
              IPC_CHANNELS.selectorStateChanged,
              wrappedListener
            )
          }
        }
      },

      roots: {
        list() {
          return ipcRenderer.invoke(IPC_CHANNELS.selector.roots.list) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["roots"]["list"]>>
          >
        }
      },

      git: {
        diffStats(paths: string[]) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.git.diffStats,
            paths
          ) as Promise<Awaited<ReturnType<HandoffApi["selector"]["git"]["diffStats"]>>>
        },

        status(paths: string[]) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.git.status,
            paths
          ) as Promise<Awaited<ReturnType<HandoffApi["selector"]["git"]["status"]>>>
        }
      },

      manifests: {
        list() {
          return ipcRenderer.invoke(IPC_CHANNELS.selector.manifests.list) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["manifests"]["list"]>>
          >
        },

        get(name: string) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.manifests.get,
            name
          ) as Promise<Awaited<ReturnType<HandoffApi["selector"]["manifests"]["get"]>>>
        },

        addFiles(name: string, paths: string[]) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.manifests.addFiles,
            name,
            paths
          ) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["manifests"]["addFiles"]>>
          >
        },

        duplicate(name: string, nextName: string) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.manifests.duplicate,
            name,
            nextName
          ) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["manifests"]["duplicate"]>>
          >
        },

        deleteBundle(name: string) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.manifests.deleteBundle,
            name
          ) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["manifests"]["deleteBundle"]>>
          >
        },

        rename(name: string, nextName: string) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.manifests.rename,
            name,
            nextName
          ) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["manifests"]["rename"]>>
          >
        },

        setComment(name: string, path: string, comment: string) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.manifests.setComment,
            name,
            path,
            comment
          ) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["manifests"]["setComment"]>>
          >
        },

        setExportText(
          name: string,
          exportPrefixText: string,
          exportSuffixText: string,
          stripComments?: boolean,
          gitDiffModeOrUseGitDiffs?: SelectorGitDiffMode | boolean
        ) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.manifests.setExportText,
            name,
            exportPrefixText,
            exportSuffixText,
            stripComments,
            gitDiffModeOrUseGitDiffs
          ) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["manifests"]["setExportText"]>>
          >
        },

        setSelected(name: string, path: string, selected: boolean) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.manifests.setSelected,
            name,
            path,
            selected
          ) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["manifests"]["setSelected"]>>
          >
        },

        setSelectedPaths(name: string, paths: string[]) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.manifests.setSelectedPaths,
            name,
            paths
          ) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["manifests"]["setSelectedPaths"]>>
          >
        },

        removeFiles(name: string, paths: string[]) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.manifests.removeFiles,
            name,
            paths
          ) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["manifests"]["removeFiles"]>>
          >
        }
      },

      files: {
        search(rootId: string, query: string, limit?: number) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.files.search,
            rootId,
            query,
            limit
          ) as Promise<Awaited<ReturnType<HandoffApi["selector"]["files"]["search"]>>>
        },

        preview(path: string) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.files.preview,
            path
          ) as Promise<Awaited<ReturnType<HandoffApi["selector"]["files"]["preview"]>>>
        }
      },

      exports: {
        estimate(name: string) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.exports.estimate,
            name
          ) as Promise<Awaited<ReturnType<HandoffApi["selector"]["exports"]["estimate"]>>>
        },

        regenerateAndCopy(name: string) {
          return ipcRenderer.invoke(
            IPC_CHANNELS.selector.exports.regenerateAndCopy,
            name
          ) as Promise<
            Awaited<ReturnType<HandoffApi["selector"]["exports"]["regenerateAndCopy"]>>
          >
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
