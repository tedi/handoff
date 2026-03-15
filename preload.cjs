const { contextBridge, ipcRenderer } = require("electron")

const IPC_CHANNELS = {
  app: {
    getStateInfo: "handoff:get-state-info",
    refresh: "handoff:refresh",
    openSourceSession: "handoff:open-source-session",
    startNewThread: "handoff:start-new-thread",
    openProjectPath: "handoff:open-project-path"
  },
  settings: {
    get: "handoff:settings:get",
    update: "handoff:settings:update",
    resetProvider: "handoff:settings:reset-provider"
  },
  sessions: {
    list: "handoff:sessions:list",
    getTranscript: "handoff:sessions:get-transcript"
  },
  search: {
    getStatus: "handoff:search:get-status",
    query: "handoff:search:query"
  },
  clipboard: {
    writeText: "handoff:clipboard:write-text"
  },
  stateChanged: "handoff:state-changed",
  searchStatusChanged: "handoff:search-status-changed"
}

contextBridge.exposeInMainWorld("handoffApp", {
  app: {
    getStateInfo() {
      return ipcRenderer.invoke(IPC_CHANNELS.app.getStateInfo)
    },
    refresh() {
      return ipcRenderer.invoke(IPC_CHANNELS.app.refresh)
    },
    openSourceSession(provider, sessionId, sessionClient, workingDirectory) {
      return ipcRenderer.invoke(
        IPC_CHANNELS.app.openSourceSession,
        provider,
        sessionId,
        sessionClient,
        workingDirectory
      )
    },
    startNewThread(params) {
      return ipcRenderer.invoke(IPC_CHANNELS.app.startNewThread, params)
    },
    openProjectPath(target, projectPath) {
      return ipcRenderer.invoke(
        IPC_CHANNELS.app.openProjectPath,
        target,
        projectPath
      )
    },
    onStateChanged(listener) {
      const wrappedListener = (_event, payload) => {
        listener(payload)
      }

      ipcRenderer.on(IPC_CHANNELS.stateChanged, wrappedListener)

      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, wrappedListener)
      }
    }
  },
  settings: {
    get() {
      return ipcRenderer.invoke(IPC_CHANNELS.settings.get)
    },
    update(patch) {
      return ipcRenderer.invoke(IPC_CHANNELS.settings.update, patch)
    },
    resetProvider(provider) {
      return ipcRenderer.invoke(IPC_CHANNELS.settings.resetProvider, provider)
    }
  },
  sessions: {
    list() {
      return ipcRenderer.invoke(IPC_CHANNELS.sessions.list)
    },
    getTranscript(id, options) {
      return ipcRenderer.invoke(
        IPC_CHANNELS.sessions.getTranscript,
        id,
        options
      )
    }
  },
  search: {
    getStatus() {
      return ipcRenderer.invoke(IPC_CHANNELS.search.getStatus)
    },
    query(params) {
      return ipcRenderer.invoke(IPC_CHANNELS.search.query, params)
    },
    onStatusChanged(listener) {
      const wrappedListener = (_event, payload) => {
        listener(payload)
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
    writeText(text) {
      return ipcRenderer.invoke(IPC_CHANNELS.clipboard.writeText, text)
    }
  }
})
