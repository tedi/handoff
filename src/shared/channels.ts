export const IPC_CHANNELS = {
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
} as const
