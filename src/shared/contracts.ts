import type {
  SelectorClipboardResult,
  SelectorDeleteBundleResult,
  SelectorExportEstimateResult,
  SelectorExportResult,
  SelectorFilePreview,
  SelectorFileRecord,
  SelectorGitDiffMode,
  SelectorGitDiffStat,
  SelectorGitStatus,
  SelectorManifestSummary,
  SelectorRoot
} from "selector"

export type SessionProvider = "codex" | "claude"
export type ThreadLaunchVendor = SessionProvider
export type AppSection = "threads" | "agents" | "selector"
export type ArchivedFilterValue = "all" | "not-archived" | "archived"
export type ProviderFilterValue = "all" | SessionProvider
export type DateRangeFilterValue = "24h" | "3d" | "7d" | "30d" | "all"
export type TerminalAppId = "terminal" | "ghostty" | "warp"
export type ThreadLaunchMode = "app" | "cli"
export type ThinkingLevel = "low" | "medium" | "high" | "max"
export type ThreadViewMode = "chronological" | "project" | "collection"
export type ThreadSortKey = "updated" | "created"

export interface AgentDefinition {
  id: string
  name: string
  specialty?: string
  provider: SessionProvider
  modelId: string
  thinkingLevel: ThinkingLevel
  fast: boolean
  timeoutSec: number | null
  customInstructions: string
}

export interface AgentUpdatePatch {
  name?: string
  specialty?: string
  provider?: SessionProvider
  modelId?: string
  thinkingLevel?: ThinkingLevel
  fast?: boolean
  timeoutSec?: number | null
  customInstructions?: string
}

export interface AgentDeleteResult {
  deletedId: string
}

export type AgentRunStatus = "running" | "completed" | "failed" | "canceled"

export type AgentCallerMetadata = string | Record<string, unknown> | null

export interface AgentRunRecord {
  runId: string
  agentId: string
  agentName: string
  status: AgentRunStatus
  provider: SessionProvider
  modelId: string
  thinkingLevel: ThinkingLevel
  fast: boolean
  projectPath: string
  message: string
  context: string | null
  caller: AgentCallerMetadata
  prompt: string
  answer: string | null
  error: string | null
  stdout: string | null
  stderr: string | null
  exitCode: number | null
  workerPid: number | null
  startedAt: string
  finishedAt: string | null
}

export interface AskAgentParams {
  agentId?: string
  agentName?: string
  message: string
  projectPath: string
  context?: string
  timeoutSec?: number | null
  caller?: AgentCallerMetadata
}

export interface AskAgentResult {
  runId: string
  status: Extract<AgentRunStatus, "completed" | "failed">
  answer: string | null
  agentId: string
  provider: SessionProvider
  modelId: string
  thinkingLevel: ThinkingLevel
  fast: boolean
  projectPath: string
  startedAt: string
  finishedAt: string
}

export interface StartAgentRunResult {
  runId: string
  status: Extract<AgentRunStatus, "running">
  agentId: string
  provider: SessionProvider
  modelId: string
  thinkingLevel: ThinkingLevel
  fast: boolean
  projectPath: string
  startedAt: string
}

export interface AgentBridgeHealth {
  status: "ready" | "error"
  message: string | null
  command: string
  args: string[]
  entrypointLabel: string
  stateDir: string
  runsLogPath: string
  locksDir: string
}

export interface AgentBridgeConfigSnippets {
  codexCommand: string
  claudeConfigJson: string
}

export type SkillInstallTarget = SessionProvider | "both"

export interface HandoffSkillProviderStatus {
  provider: SessionProvider
  configPath: string
  configExists: boolean
  skillPath: string
  skillInstalled: boolean
  mcpInstalled: boolean
  managedConfigBlock: boolean
  error: string | null
}

export interface HandoffSkillsStatus {
  skillName: string
  managedRoot: string
  exportRoot: string
  providers: Record<SessionProvider, HandoffSkillProviderStatus>
}

export interface HandoffSkillsExportResult {
  exportPath: string
  codexPath: string
  claudePath: string
  claudePluginPath: string
}

export interface SessionIndexEntry {
  id: string
  sourceSessionId: string
  provider: SessionProvider
  archived: boolean
  threadName: string
  createdAt: string
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

export type RootListItem = Pick<SelectorRoot, "id" | "path" | "exists">

export interface SelectorAppStateInfo {
  stateDir: string
  configPath: string
  manifestsDir: string
  exportsDir: string
  selectorHome: string | null
}

export interface SelectorAppOpenPathResult {
  path: string
  opened_with: string
}

export type SelectorAppStateChangeReason =
  | "config-changed"
  | "manifests-changed"
  | "exports-changed"
  | "manual-refresh"
  | "state-changed"

export interface SelectorAppStateChangeEvent {
  at: string
  reason: SelectorAppStateChangeReason
  changedPath: string | null
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

export interface NewThreadDraft {
  sourceSessionId: string | null
  projectPath: string | null
  includeDiffs: boolean
  vendor: ThreadLaunchVendor
  launchMode: ThreadLaunchMode
  modelId: string
  thinkingLevel: ThinkingLevel
  fast: boolean
  prompt: string
}

export interface NewThreadLaunchParams {
  provider: ThreadLaunchVendor
  launchMode: ThreadLaunchMode
  modelId: string
  projectPath: string
  prompt: string
  thinkingLevel: ThinkingLevel
  fast: boolean
}

export interface NewThreadLaunchResult extends OpenActionResult {
  launchMode: ThreadLaunchMode
  copiedPrompt: boolean
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

export interface ProjectGroupState {
  projectPath: string
  alias: string
  collapsed: boolean
  order: number | null
  threadOrder: string[]
}

export type ThreadCollectionIcon =
  | "stack"
  | "bookmark"
  | "star"
  | "bolt"
  | "target"
  | "briefcase"

export interface ThreadCollection {
  id: string
  name: string
  icon?: ThreadCollectionIcon
  color?: string
  collapsed: boolean
  order: number | null
  threadIds: string[]
}

export interface ThreadOrganizationSettings {
  viewMode: ThreadViewMode
  sortKey: ThreadSortKey
  projects: Record<string, ProjectGroupState>
  collections: ThreadCollection[]
}

export interface ProviderLaunchOverrides {
  binaryPath: string
  homePath: string
}

export interface SkillProviderSettings {
  toolTimeoutSec: number | null
}

export interface TerminalPreferences {
  enabledTerminalIds: TerminalAppId[]
  defaultTerminalId: TerminalAppId
}

export interface HandoffSettings {
  providers: Record<SessionProvider, ProviderLaunchOverrides>
  skills?: Record<SessionProvider, SkillProviderSettings>
  terminals: TerminalPreferences
  agents: AgentDefinition[]
  threadOrganization: ThreadOrganizationSettings
}

export interface HandoffSettingsPatch {
  providers?: Partial<Record<SessionProvider, Partial<ProviderLaunchOverrides>>>
  skills?: Partial<Record<SessionProvider, Partial<SkillProviderSettings>>>
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
    startNewThread(params: NewThreadLaunchParams): Promise<NewThreadLaunchResult>
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
  agents: {
    list(): Promise<AgentDefinition[]>
    create(): Promise<AgentDefinition>
    update(id: string, patch: AgentUpdatePatch): Promise<AgentDefinition>
    delete(id: string): Promise<AgentDeleteResult>
    duplicate(id: string): Promise<AgentDefinition>
  }
  threads: {
    get(): Promise<ThreadOrganizationSettings>
    update(settings: ThreadOrganizationSettings): Promise<ThreadOrganizationSettings>
  }
  bridge: {
    getStatus(): Promise<AgentBridgeHealth>
    getConfigSnippets(): Promise<AgentBridgeConfigSnippets>
    listRuns(agentId?: string, limit?: number): Promise<AgentRunRecord[]>
    getRun(runId: string): Promise<AgentRunRecord | null>
    cancelRun(runId: string): Promise<AgentRunRecord | null>
  }
  skills: {
    getStatus(): Promise<HandoffSkillsStatus>
    install(target: SkillInstallTarget): Promise<HandoffSkillsStatus>
    exportPackage(): Promise<HandoffSkillsExportResult>
    copySetupInstructions(target: SkillInstallTarget): Promise<ClipboardWriteResult>
  }
  selector: {
    app: {
      getStateInfo(): Promise<SelectorAppStateInfo>
      openPath(path: string): Promise<SelectorAppOpenPathResult>
      refresh(): Promise<SelectorAppStateChangeEvent>
      onStateChanged(
        listener: (event: SelectorAppStateChangeEvent) => void
      ): () => void
    }
    roots: {
      list(): Promise<RootListItem[]>
    }
    git: {
      diffStats(paths: string[]): Promise<Record<string, SelectorGitDiffStat>>
      status(paths: string[]): Promise<Record<string, SelectorGitStatus>>
    }
    manifests: {
      list(): Promise<SelectorManifestSummary[]>
      get(name: string): Promise<SelectorManifestSummary>
      addFiles(name: string, paths: string[]): Promise<SelectorManifestSummary>
      duplicate(name: string, nextName: string): Promise<SelectorManifestSummary>
      deleteBundle(name: string): Promise<SelectorDeleteBundleResult>
      rename(name: string, nextName: string): Promise<SelectorManifestSummary>
      setComment(
        name: string,
        path: string,
        comment: string
      ): Promise<SelectorManifestSummary>
      setExportText(
        name: string,
        exportPrefixText: string,
        exportSuffixText: string,
        stripComments?: boolean,
        gitDiffModeOrUseGitDiffs?: SelectorGitDiffMode | boolean
      ): Promise<SelectorManifestSummary>
      setSelected(
        name: string,
        path: string,
        selected: boolean
      ): Promise<SelectorManifestSummary>
      setSelectedPaths(
        name: string,
        paths: string[]
      ): Promise<SelectorManifestSummary>
      removeFiles(
        name: string,
        paths: string[]
      ): Promise<SelectorManifestSummary>
    }
    files: {
      search(
        rootId: string,
        query: string,
        limit?: number
      ): Promise<{
        root: {
          id: string
          path: string
        }
        files: SelectorFileRecord[]
      }>
      preview(path: string): Promise<SelectorFilePreview>
    }
    exports: {
      estimate(name: string): Promise<SelectorExportEstimateResult>
      regenerateAndCopy(
        name: string
      ): Promise<SelectorExportResult & SelectorClipboardResult>
    }
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
