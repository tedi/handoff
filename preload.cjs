const { contextBridge, ipcRenderer } = require("electron")

const IPC_CHANNELS = {
  app: {
    getStateInfo: "handoff:get-state-info",
    refresh: "handoff:refresh",
    openSourceSession: "handoff:open-source-session",
    openProjectPath: "handoff:open-project-path"
  },
  sessions: {
    list: "handoff:sessions:list",
    getTranscript: "handoff:sessions:get-transcript"
  },
  clipboard: {
    writeText: "handoff:clipboard:write-text"
  },
  stateChanged: "handoff:state-changed"
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
  clipboard: {
    writeText(text) {
      return ipcRenderer.invoke(IPC_CHANNELS.clipboard.writeText, text)
    }
  }
})
