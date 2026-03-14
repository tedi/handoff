export type SessionProvider = "codex" | "claude"
export type ArchivedFilterValue = "all" | "not-archived" | "archived"
export type ProviderFilterValue = "all" | SessionProvider
export type DateRangeFilterValue = "24h" | "3d" | "7d" | "30d" | "all"
export type TerminalAppId = "terminal" | "ghostty" | "warp"

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

export interface OpenActionResult {
  fallbackMessage?: string | null
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

export interface ProviderLaunchOverrides {
  binaryPath: string
  homePath: string
}

export interface TerminalPreferences {
  enabledTerminalIds: TerminalAppId[]
  defaultTerminalId: TerminalAppId
}

export interface HandoffSettings {
  providers: Record<SessionProvider, ProviderLaunchOverrides>
  terminals: TerminalPreferences
}

export interface HandoffSettingsPatch {
  providers?: Partial<Record<SessionProvider, Partial<ProviderLaunchOverrides>>>
  terminals?: Partial<TerminalPreferences>
}

export interface TerminalOption {
  id: TerminalAppId
  label: string
  installed: boolean
}

export interface ProviderSettingsInfo {
  provider: SessionProvider
  binarySource: "default" | "override"
  effectiveBinaryPath: string
  homeSource: "default" | "override"
  effectiveHomePath: string
  configPath: string
  configExists: boolean
  model: string | null
  reasoningEffort: string | null
  serviceTier: string | null
  effortLevel: string | null
  alwaysThinkingEnabled: boolean | null
  observedModel: string | null
}

export interface HandoffSettingsSnapshot {
  settings: HandoffSettings
  providerInfo: Record<SessionProvider, ProviderSettingsInfo>
  terminalOptions: TerminalOption[]
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
    ): Promise<OpenActionResult>
    openProjectPath(
      target: ProjectLocationTarget,
      projectPath: string
    ): Promise<OpenActionResult>
    onStateChanged(listener: (event: HandoffStateChangeEvent) => void): () => void
  }
  settings: {
    get(): Promise<HandoffSettingsSnapshot>
    update(patch: HandoffSettingsPatch): Promise<HandoffSettingsSnapshot>
    resetProvider(provider: SessionProvider): Promise<HandoffSettingsSnapshot>
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
