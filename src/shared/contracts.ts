export interface SessionIndexEntry {
  id: string
  threadName: string
  updatedAt: string
}

export interface SessionListItem extends SessionIndexEntry {
  sessionPath: string | null
}

export interface TranscriptOptions {
  includeDiffs: boolean
  includeCommentary: boolean
}

export interface ConversationPatch {
  id: string
  patch: string
  files: string[]
}

interface BaseConversationEntry {
  id: string
  role: "user" | "assistant"
  timestamp: string
  bodyMarkdown: string
}

export interface UserConversationEntry extends BaseConversationEntry {
  kind: "message"
  role: "user"
}

export interface AssistantMessageEntry extends BaseConversationEntry {
  kind: "message"
  role: "assistant"
  patches: ConversationPatch[]
}

export interface AssistantCommentaryEntry extends BaseConversationEntry {
  kind: "commentary"
  role: "assistant"
  collapsedByDefault: true
  previewText: string
}

export type ConversationEntry =
  | UserConversationEntry
  | AssistantMessageEntry
  | AssistantCommentaryEntry

export interface ConversationTranscript {
  id: string
  threadName: string
  updatedAt: string
  sessionPath: string | null
  entries: ConversationEntry[]
  markdown: string
  lastAssistantMarkdown: string | null
  hasDiffs: boolean
}

export interface AppStateInfo {
  indexPath: string
  sessionsRoot: string
  outputDir: string | null
}

export type HandoffStateChangeReason =
  | "index-changed"
  | "selected-session-changed"
  | "manual-refresh"

export interface HandoffStateChangeEvent {
  at: string
  reason: HandoffStateChangeReason
  changedPath: string | null
}

export interface ClipboardWriteResult {
  copied: true
}

export interface HandoffApi {
  app: {
    getStateInfo(): Promise<AppStateInfo>
    refresh(): Promise<HandoffStateChangeEvent>
    onStateChanged(listener: (event: HandoffStateChangeEvent) => void): () => void
  }
  sessions: {
    list(): Promise<SessionListItem[]>
    getTranscript(
      id: string,
      options: TranscriptOptions
    ): Promise<ConversationTranscript>
  }
  clipboard: {
    writeText(text: string): Promise<ClipboardWriteResult>
  }
}
