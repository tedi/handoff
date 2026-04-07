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
  agents: {
    list: "handoff:agents:list",
    create: "handoff:agents:create",
    update: "handoff:agents:update",
    delete: "handoff:agents:delete",
    duplicate: "handoff:agents:duplicate"
  },
  threads: {
    get: "handoff:threads:get",
    update: "handoff:threads:update"
  },
  controlCenter: {
    getSnapshot: "handoff:control-center:get-snapshot",
    open: "handoff:control-center:open",
    dismiss: "handoff:control-center:dismiss",
    dismissCompleted: "handoff:control-center:dismiss-completed"
  },
  bridge: {
    getStatus: "handoff:bridge:get-status",
    getConfigSnippets: "handoff:bridge:get-config-snippets",
    listRuns: "handoff:bridge:list-runs",
    getRun: "handoff:bridge:get-run",
    cancelRun: "handoff:bridge:cancel-run"
  },
  skills: {
    getStatus: "handoff:skills:get-status",
    install: "handoff:skills:install",
    exportPackage: "handoff:skills:export-package",
    copySetupInstructions: "handoff:skills:copy-setup-instructions"
  },
  selector: {
    app: {
      getStateInfo: "handoff:selector:get-state-info",
      openPath: "handoff:selector:open-path",
      refresh: "handoff:selector:refresh"
    },
    roots: {
      list: "handoff:selector:roots:list"
    },
    git: {
      diffStats: "handoff:selector:git:diff-stats",
      status: "handoff:selector:git:status"
    },
    manifests: {
      list: "handoff:selector:manifests:list",
      get: "handoff:selector:manifests:get",
      addFiles: "handoff:selector:manifests:add-files",
      duplicate: "handoff:selector:manifests:duplicate",
      deleteBundle: "handoff:selector:manifests:delete-bundle",
      rename: "handoff:selector:manifests:rename",
      setComment: "handoff:selector:manifests:set-comment",
      setExportText: "handoff:selector:manifests:set-export-text",
      setSelected: "handoff:selector:manifests:set-selected",
      setSelectedPaths: "handoff:selector:manifests:set-selected-paths",
      removeFiles: "handoff:selector:manifests:remove-files"
    },
    files: {
      search: "handoff:selector:files:search",
      preview: "handoff:selector:files:preview"
    },
    exports: {
      estimate: "handoff:selector:exports:estimate",
      regenerateAndCopy: "handoff:selector:exports:regenerate-and-copy"
    }
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
  controlCenterStateChanged: "handoff:control-center-state-changed",
  searchStatusChanged: "handoff:search-status-changed",
  selectorStateChanged: "handoff:selector-state-changed"
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
  agents: {
    list() {
      return ipcRenderer.invoke(IPC_CHANNELS.agents.list)
    },
    create() {
      return ipcRenderer.invoke(IPC_CHANNELS.agents.create)
    },
    update(id, patch) {
      return ipcRenderer.invoke(IPC_CHANNELS.agents.update, id, patch)
    },
    delete(id) {
      return ipcRenderer.invoke(IPC_CHANNELS.agents.delete, id)
    },
    duplicate(id) {
      return ipcRenderer.invoke(IPC_CHANNELS.agents.duplicate, id)
    }
  },
  threads: {
    get() {
      return ipcRenderer.invoke(IPC_CHANNELS.threads.get)
    },
    update(settings) {
      return ipcRenderer.invoke(IPC_CHANNELS.threads.update, settings)
    }
  },
  controlCenter: {
    getSnapshot() {
      return ipcRenderer.invoke(IPC_CHANNELS.controlCenter.getSnapshot)
    },
    open(threadId) {
      return ipcRenderer.invoke(IPC_CHANNELS.controlCenter.open, threadId)
    },
    dismiss(threadId) {
      return ipcRenderer.invoke(IPC_CHANNELS.controlCenter.dismiss, threadId)
    },
    dismissCompleted() {
      return ipcRenderer.invoke(IPC_CHANNELS.controlCenter.dismissCompleted)
    },
    onStateChanged(listener) {
      const wrappedListener = (_event, payload) => {
        listener(payload)
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
      return ipcRenderer.invoke(IPC_CHANNELS.bridge.getStatus)
    },
    getConfigSnippets() {
      return ipcRenderer.invoke(IPC_CHANNELS.bridge.getConfigSnippets)
    },
    listRuns(agentId, limit) {
      return ipcRenderer.invoke(IPC_CHANNELS.bridge.listRuns, agentId, limit)
    },
    getRun(runId) {
      return ipcRenderer.invoke(IPC_CHANNELS.bridge.getRun, runId)
    },
    cancelRun(runId) {
      return ipcRenderer.invoke(IPC_CHANNELS.bridge.cancelRun, runId)
    }
  },
  skills: {
    getStatus() {
      return ipcRenderer.invoke(IPC_CHANNELS.skills.getStatus)
    },
    install(target) {
      return ipcRenderer.invoke(IPC_CHANNELS.skills.install, target)
    },
    exportPackage() {
      return ipcRenderer.invoke(IPC_CHANNELS.skills.exportPackage)
    },
    copySetupInstructions(target) {
      return ipcRenderer.invoke(IPC_CHANNELS.skills.copySetupInstructions, target)
    }
  },
  selector: {
    app: {
      getStateInfo() {
        return ipcRenderer.invoke(IPC_CHANNELS.selector.app.getStateInfo)
      },
      openPath(path) {
        return ipcRenderer.invoke(IPC_CHANNELS.selector.app.openPath, path)
      },
      refresh() {
        return ipcRenderer.invoke(IPC_CHANNELS.selector.app.refresh)
      },
      onStateChanged(listener) {
        const wrappedListener = (_event, payload) => {
          listener(payload)
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
        return ipcRenderer.invoke(IPC_CHANNELS.selector.roots.list)
      }
    },
    git: {
      diffStats(paths) {
        return ipcRenderer.invoke(IPC_CHANNELS.selector.git.diffStats, paths)
      },
      status(paths) {
        return ipcRenderer.invoke(IPC_CHANNELS.selector.git.status, paths)
      }
    },
    manifests: {
      list() {
        return ipcRenderer.invoke(IPC_CHANNELS.selector.manifests.list)
      },
      get(name) {
        return ipcRenderer.invoke(IPC_CHANNELS.selector.manifests.get, name)
      },
      addFiles(name, paths) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.manifests.addFiles,
          name,
          paths
        )
      },
      duplicate(name, nextName) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.manifests.duplicate,
          name,
          nextName
        )
      },
      deleteBundle(name) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.manifests.deleteBundle,
          name
        )
      },
      rename(name, nextName) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.manifests.rename,
          name,
          nextName
        )
      },
      setComment(name, path, comment) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.manifests.setComment,
          name,
          path,
          comment
        )
      },
      setExportText(name, exportPrefixText, exportSuffixText, stripComments, gitDiffModeOrUseGitDiffs) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.manifests.setExportText,
          name,
          exportPrefixText,
          exportSuffixText,
          stripComments,
          gitDiffModeOrUseGitDiffs
        )
      },
      setSelected(name, path, selected) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.manifests.setSelected,
          name,
          path,
          selected
        )
      },
      setSelectedPaths(name, paths) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.manifests.setSelectedPaths,
          name,
          paths
        )
      },
      removeFiles(name, paths) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.manifests.removeFiles,
          name,
          paths
        )
      }
    },
    files: {
      search(rootId, query, limit) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.files.search,
          rootId,
          query,
          limit
        )
      },
      preview(path) {
        return ipcRenderer.invoke(IPC_CHANNELS.selector.files.preview, path)
      }
    },
    exports: {
      estimate(name) {
        return ipcRenderer.invoke(IPC_CHANNELS.selector.exports.estimate, name)
      },
      regenerateAndCopy(name) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.selector.exports.regenerateAndCopy,
          name
        )
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
