export interface SessionIndexEntry {
  id: string
  threadName: string
  updatedAt: string
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
  threadName: string
  updatedAt: string
  sessionPath: string | null
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
  outputDir: string | null
  codexIconDataUrl?: string | null
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
    openCodexThread(
      sessionId: string,
      sessionClient?: SessionClient,
      sessionCwd?: string | null
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
  clipboard: {
    writeText(text: string): Promise<ClipboardWriteResult>
  }
}
