export const IPC_CHANNELS = {
  app: {
    getStateInfo: "handoff:get-state-info",
    refresh: "handoff:refresh",
    openCodexThread: "handoff:open-codex-thread"
  },
  sessions: {
    list: "handoff:sessions:list",
    getTranscript: "handoff:sessions:get-transcript"
  },
  clipboard: {
    writeText: "handoff:clipboard:write-text"
  },
  stateChanged: "handoff:state-changed"
} as const
