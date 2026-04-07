export const IPC_CHANNELS = {
  app: {
    getStateInfo: "handoff:get-state-info",
    refresh: "handoff:refresh",
    openSourceSession: "handoff:open-source-session",
    startNewThread: "handoff:start-new-thread",
    openProjectPath: "handoff:open-project-path",
    openControlCenterPopout: "handoff:open-control-center-popout",
    closeControlCenterPopout: "handoff:close-control-center-popout"
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
    performAction: "handoff:control-center:perform-action",
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
} as const
