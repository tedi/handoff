export type SessionProvider = "codex" | "claude"
export type ArchivedFilterValue = "all" | "not-archived" | "archived"
export type ProviderFilterValue = "all" | SessionProvider
export type DateRangeFilterValue = "24h" | "3d" | "7d" | "30d" | "all"

export interface SessionIndexEntry {
  id: string
  sourceSessionId: string
  provider: SessionProvider
  archived: boolean
  threadName: string
  updatedAt: string
  projectPath: string | null
}

export interface SessionListItem extends SessionIndexEntry {
  sessionPath: string | null
}

export type SessionClient = "desktop" | "cli" | "unknown"
export type ProjectLocationTarget = "finder" | "terminal" | "editor"

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
}

interface MarkdownConversationEntry extends BaseConversationEntry {
  bodyMarkdown: string
}

export interface UserConversationEntry extends MarkdownConversationEntry {
  kind: "message"
  role: "user"
}

export interface AssistantMessageEntry extends MarkdownConversationEntry {
  kind: "message"
  role: "assistant"
  patches: ConversationPatch[]
}

export interface ThoughtChainStep {
  id: string
  bodyMarkdown: string
}

export interface AssistantThoughtChainEntry extends BaseConversationEntry {
  kind: "thought_chain"
  role: "assistant"
  collapsedByDefault: true
  messageCount: number
  messages: ThoughtChainStep[]
}

export type ConversationEntry =
  | UserConversationEntry
  | AssistantMessageEntry
  | AssistantThoughtChainEntry

export interface ConversationTranscript {
  id: string
  sourceSessionId: string
  provider: SessionProvider
  archived: boolean
  threadName: string
  updatedAt: string
  sessionPath: string | null
  projectPath: string | null
  sessionClient?: SessionClient
  sessionCwd?: string | null
  entries: ConversationEntry[]
  markdown: string
  lastAssistantMarkdown: string | null
  hasDiffs: boolean
}

export interface AppStateInfo {
  indexPath: string
  sessionsRoot: string
  claudeProjectsRoot: string
  outputDir: string | null
  codexIconDataUrl?: string | null
  claudeIconDataUrl?: string | null
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

export interface SearchFilters {
  archived: ArchivedFilterValue
  provider: ProviderFilterValue
  projectPaths: string[]
  dateRange: DateRangeFilterValue
}

export interface SearchResult extends SessionListItem {
  snippet: string
  score: number
}

export interface SearchStatus {
  state: "warming" | "ready" | "error"
  message: string | null
  indexedAt: string | null
  documentCount: number
}

export interface HandoffApi {
  app: {
    getStateInfo(): Promise<AppStateInfo>
    refresh(): Promise<HandoffStateChangeEvent>
    openSourceSession(
      provider: SessionProvider,
      sessionId: string,
      sessionClient?: SessionClient,
      workingDirectory?: string | null
    ): Promise<void>
    openProjectPath(
      target: ProjectLocationTarget,
      projectPath: string
    ): Promise<void>
    onStateChanged(listener: (event: HandoffStateChangeEvent) => void): () => void
  }
  sessions: {
    list(): Promise<SessionListItem[]>
    getTranscript(
      id: string,
      options: TranscriptOptions
    ): Promise<ConversationTranscript>
  }
  search: {
    getStatus(): Promise<SearchStatus>
    query(params: {
      query: string
      filters: SearchFilters
      limit: number
    }): Promise<SearchResult[]>
    onStatusChanged(listener: (status: SearchStatus) => void): () => void
  }
  clipboard: {
    writeText(text: string): Promise<ClipboardWriteResult>
  }
}
