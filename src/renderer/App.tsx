import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react"
import Prism from "prismjs"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import "prismjs/components/prism-bash"
import "prismjs/components/prism-clike"
import "prismjs/components/prism-css"
import "prismjs/components/prism-javascript"
import "prismjs/components/prism-jsx"
import "prismjs/components/prism-json"
import "prismjs/components/prism-markdown"
import "prismjs/components/prism-markup"
import "prismjs/components/prism-tsx"
import "prismjs/components/prism-typescript"

import type {
  AgentDefinition,
  AgentBridgeConfigSnippets,
  AgentBridgeHealth,
  AgentRunRecord,
  AgentUpdatePatch,
  ArchivedFilterValue,
  AppStateInfo,
  AppSection,
  AssistantMessageEntry,
  AssistantThoughtChainEntry,
  ConversationPatch,
  ConversationTranscript,
  DateRangeFilterValue,
  HandoffApi,
  HandoffSkillsStatus,
  NewThreadDraft,
  HandoffSettingsPatch,
  HandoffSettingsSnapshot,
  NewThreadLaunchParams,
  ProjectLocationTarget,
  ProviderLaunchOverrides,
  ProviderSettingsInfo,
  ProviderFilterValue,
  SearchFilters,
  SearchResult,
  SearchStatus,
  SessionClient,
  SessionListItem,
  SessionProvider,
  SkillInstallTarget,
  TerminalAppId,
  TerminalOption,
  ThinkingLevel,
  ThreadCollection,
  ThreadCollectionIcon,
  ThreadLaunchMode,
  ThreadLaunchVendor,
  ThreadOrganizationSettings,
  ThreadSortKey,
  ThreadViewMode
} from "../shared/contracts"
import {
  getComposerModelLabel,
  getComposerModelOptions,
  getComposerProviderConfig,
  getDefaultComposerLaunchMode,
  getDefaultComposerModelId,
  isComposerLaunchModeSupported,
  normalizeComposerTarget,
  THINKING_LEVEL_OPTIONS
} from "../shared/provider-config"
import {
  detectCodeLanguage,
  parseApplyPatches,
  type ParsedPatchFile,
  type ParsedPatchLine
} from "../shared/patch"
import {
  SelectorAddFilesModal,
  SelectorBundleDialog,
  SelectorDetailPane,
  SelectorSidebarPane,
  useSelectorSection
} from "./selector-section"

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value))
}

function formatRelativeTimestamp(value: string) {
  const diffMs = Date.now() - new Date(value).getTime()
  const diffMinutes = Math.max(Math.floor(diffMs / 60000), 0)

  if (diffMinutes < 60) {
    return `${Math.max(diffMinutes, 1)}m`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours}h`
  }

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) {
    return `${diffDays}d`
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(new Date(value))
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function formatAdditionCount(value: number) {
  return `+${Math.max(value, 0)}`
}

function formatDeletionCount(value: number) {
  return `-${Math.max(value, 0)}`
}

function formatProjectLocationLabel(target: ProjectLocationTarget) {
  if (target === "finder") {
    return "Finder"
  }

  if (target === "terminal") {
    return "Terminal"
  }

  return "Editor"
}

function formatProviderLabel(provider: SessionProvider) {
  return provider === "claude" ? "Claude" : "Codex"
}

function formatTerminalLabel(terminalId: TerminalAppId) {
  if (terminalId === "ghostty") {
    return "Ghostty"
  }

  if (terminalId === "warp") {
    return "Warp"
  }

  return "Terminal"
}

function getProviderIconDataUrl(
  provider: SessionProvider,
  stateInfo: AppStateInfo | null
) {
  if (!stateInfo) {
    return null
  }

  return provider === "claude"
    ? stateInfo.claudeIconDataUrl ?? null
    : stateInfo.codexIconDataUrl ?? null
}

function ProviderIcon({
  provider,
  stateInfo
}: {
  provider: SessionProvider
  stateInfo: AppStateInfo | null
}) {
  const label = formatProviderLabel(provider)
  const iconDataUrl = getProviderIconDataUrl(provider, stateInfo)

  return (
    <span
      className={`provider-icon provider-icon-${provider}`}
      title={label}
    >
      {iconDataUrl ? (
        <img
          alt=""
          aria-hidden="true"
          className="provider-icon-image"
          src={iconDataUrl}
        />
      ) : (
        <span aria-hidden="true" className="provider-icon-fallback">
          {provider === "claude" ? "Cl" : "Co"}
        </span>
      )}
    </span>
  )
}

const SECTION_RAIL_WIDTH = 76
const DEFAULT_SIDEBAR_WIDTH = 280
const MIN_SIDEBAR_WIDTH = 220
const SIDEBAR_WIDTH_STORAGE_KEY = "handoff.sidebar-width"
const SIDEBAR_COLLAPSED_STORAGE_KEY = "handoff.sidebar-collapsed"
const NEW_THREAD_INCLUDE_DIFFS_STORAGE_KEY = "handoff.new-thread-include-diffs"

interface ProjectFilterOption {
  path: string
  label: string
}

type FilterMenuKey = "archived" | "provider" | "project" | "date"
type NewThreadTargetMenuKey = "vendor" | "launchMode" | "model" | "options"
type CopyActionKey = "chat" | "chat-with-diffs" | "last-message"
type OutputFormatKey = "markdown" | "json" | "structured"
type ThreadGroupMenuKind = "project" | "collection"

interface ThreadSidebarGroup {
  id: string
  kind: ThreadGroupMenuKind | "system"
  title: string
  subtitle: string | null
  projectPath: string | null
  collectionId: string | null
  collapsed: boolean
  sessions: SessionListItem[]
  canRename: boolean
  canDelete: boolean
  canReorder: boolean
  collectionIcon?: ThreadCollection["icon"]
  collectionColor?: string
}

type ThreadDragItem =
  | { type: "project-group"; projectPath: string }
  | { type: "project-thread"; projectPath: string; threadId: string }
  | { type: "collection-group"; collectionId: string }
  | { type: "collection-thread"; collectionId: string | null; threadId: string }

type ThreadDropIndicator =
  | { type: "project-group"; projectPath: string; position: "before" | "after" }
  | { type: "project-thread"; projectPath: string; threadId: string; position: "before" | "after" }
  | { type: "project-append"; projectPath: string }
  | { type: "collection-group"; collectionId: string; position: "before" | "after" }
  | {
      type: "collection-thread"
      collectionId: string | null
      threadId: string
      position: "before" | "after"
    }
  | { type: "collection-append"; collectionId: string | null }

function CollectionCreateDialog({
  value,
  inputRef,
  onCancel,
  onChange,
  onSubmit
}: {
  value: string
  inputRef: { current: HTMLInputElement | null }
  onCancel(): void
  onChange(value: string): void
  onSubmit(): void
}) {
  return (
    <div
      aria-label="Create collection"
      className="app-modal-backdrop"
      onClick={onCancel}
      role="dialog"
    >
      <div
        className="app-modal-card"
        onClick={event => event.stopPropagation()}
      >
        <div className="settings-card-copy">
          <h2>New collection</h2>
          <p>Name the collection to add it to the top of the list.</p>
        </div>

        <label className="settings-field">
          <span className="settings-field-label">Collection name</span>
          <input
            className="settings-input"
            onChange={event => onChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault()
                onSubmit()
                return
              }

              if (event.key === "Escape") {
                event.preventDefault()
                onCancel()
              }
            }}
            ref={inputRef}
            type="text"
            value={value}
          />
        </label>

        <div className="app-modal-actions">
          <button className="ghost-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="accent-button" onClick={onSubmit} type="button">
            Create collection
          </button>
        </div>
      </div>
    </div>
  )
}

function CollectionAppearanceDialog({
  color,
  icon,
  onCancel,
  onColorSelect,
  onIconSelect,
  onSubmit
}: {
  color: string
  icon: ThreadCollection["icon"] | null | undefined
  onCancel(): void
  onColorSelect(color: string): void
  onIconSelect(icon: ThreadCollectionIcon): void
  onSubmit(): void
}) {
  return (
    <div
      aria-label="Edit collection appearance"
      className="app-modal-backdrop"
      onClick={onCancel}
      role="dialog"
    >
      <div className="app-modal-card" onClick={event => event.stopPropagation()}>
        <div className="settings-card-copy">
          <h2>Edit collection appearance</h2>
          <p>Choose the icon and color for this collection.</p>
        </div>

        <div className="settings-field">
          <span className="settings-field-label">Icon</span>
          <div className="collection-icon-grid">
            {THREAD_COLLECTION_ICON_OPTIONS.map(option => {
              const isSelected = resolveCollectionIcon(icon) === option.value

              return (
                <button
                  aria-label={option.label}
                  className={`collection-icon-swatch ${isSelected ? "is-selected" : ""}`}
                  key={option.value}
                  onClick={() => onIconSelect(option.value)}
                  style={{ "--collection-color": resolveCollectionColor(color) } as CSSProperties}
                  type="button"
                >
                  <CollectionSymbol icon={option.value} />
                </button>
              )
            })}
          </div>
        </div>

        <div className="settings-field">
          <span className="settings-field-label">Color</span>
          <div className="collection-color-grid">
            {THREAD_COLLECTION_COLOR_OPTIONS.map(option => {
              const isSelected = resolveCollectionColor(color) === option

              return (
                <button
                  aria-label={`Color ${option}`}
                  className={`collection-color-swatch ${isSelected ? "is-selected" : ""}`}
                  key={option}
                  onClick={() => onColorSelect(option)}
                  style={{ "--collection-color": option } as CSSProperties}
                  type="button"
                />
              )
            })}
          </div>
        </div>

        <div className="app-modal-actions">
          <button className="ghost-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="accent-button" onClick={onSubmit} type="button">
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

const NO_PROJECT_GROUP_ID = "__no-project__"
const UNASSIGNED_COLLECTION_GROUP_ID = "__unassigned__"

const DEFAULT_SIDEBAR_FILTERS: SearchFilters = {
  archived: "not-archived",
  provider: "all",
  projectPaths: [],
  dateRange: "30d"
}

const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  archived: "not-archived",
  provider: "all",
  projectPaths: [],
  dateRange: "30d"
}

const DEFAULT_THREAD_ORGANIZATION: ThreadOrganizationSettings = {
  viewMode: "chronological",
  sortKey: "updated",
  projects: {},
  collections: []
}

const DEFAULT_THREAD_COLLECTION_ICON: ThreadCollectionIcon = "stack"
const DEFAULT_THREAD_COLLECTION_COLOR = "#8b7cf6"
const THREAD_COLLECTION_COLOR_OPTIONS = [
  "#8b7cf6",
  "#22c55e",
  "#06b6d4",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#84cc16",
  "#14b8a6",
  "#3b82f6",
  "#f97316"
] as const
const THREAD_COLLECTION_ICON_OPTIONS: Array<{
  value: ThreadCollectionIcon
  label: string
}> = [
  { value: "stack", label: "Stack" },
  { value: "bookmark", label: "Bookmark" },
  { value: "star", label: "Star" },
  { value: "bolt", label: "Bolt" },
  { value: "target", label: "Target" },
  { value: "briefcase", label: "Briefcase" }
]

const THREAD_VIEW_MODE_OPTIONS: Array<{
  label: string
  value: ThreadViewMode
}> = [
  { label: "By project", value: "project" },
  { label: "By collection", value: "collection" },
  { label: "Chronological list", value: "chronological" }
]

const THREAD_SORT_KEY_OPTIONS: Array<{
  label: string
  value: ThreadSortKey
}> = [
  { label: "Created", value: "created" },
  { label: "Updated", value: "updated" }
]

const ARCHIVED_FILTER_OPTIONS: Array<{
  label: string
  value: ArchivedFilterValue
}> = [
  { label: "All", value: "all" },
  { label: "Not Archived", value: "not-archived" },
  { label: "Archived", value: "archived" }
]

const PROVIDER_FILTER_OPTIONS: Array<{
  label: string
  value: ProviderFilterValue
}> = [
  { label: "All", value: "all" },
  { label: "Claude", value: "claude" },
  { label: "Codex", value: "codex" }
]

const DATE_FILTER_OPTIONS: Array<{
  label: string
  value: DateRangeFilterValue
}> = [
  { label: "Last 24h", value: "24h" },
  { label: "Last 3 days", value: "3d" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "All dates", value: "all" }
]

const OUTPUT_FORMAT_OPTIONS: Array<{
  key: OutputFormatKey
  label: string
}> = [
  { key: "markdown", label: "Markdown" },
  { key: "json", label: "JSON" },
  { key: "structured", label: "Structured" }
]

const NEW_THREAD_VENDOR_OPTIONS: Array<{
  value: ThreadLaunchVendor
  label: string
}> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" }
]

const NEW_THREAD_LAUNCH_MODE_OPTIONS: Array<{
  value: ThreadLaunchMode
  label: string
}> = [
  { value: "cli", label: "CLI" },
  { value: "app", label: "App" }
]

function applySettingsPatchToSnapshot(
  snapshot: HandoffSettingsSnapshot,
  patch: HandoffSettingsPatch
) {
  return {
    ...snapshot,
    settings: {
      agents: snapshot.settings.agents,
      threadOrganization: snapshot.settings.threadOrganization,
      providers: {
        codex: {
          ...snapshot.settings.providers.codex,
          ...(patch.providers?.codex ?? {})
        },
        claude: {
          ...snapshot.settings.providers.claude,
          ...(patch.providers?.claude ?? {})
        }
      },
      skills: {
        codex: {
          toolTimeoutSec: snapshot.settings.skills?.codex?.toolTimeoutSec ?? null,
          ...(patch.skills?.codex ?? {})
        },
        claude: {
          toolTimeoutSec: snapshot.settings.skills?.claude?.toolTimeoutSec ?? null,
          ...(patch.skills?.claude ?? {})
        }
      },
      terminals: {
        ...snapshot.settings.terminals,
        ...(patch.terminals ?? {})
      }
    }
  }
}

function clampSidebarWidth(value: number, viewportWidth: number) {
  const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.floor(viewportWidth * 0.4))
  const minWidth = Math.min(MIN_SIDEBAR_WIDTH, maxWidth)
  return Math.min(Math.max(Math.round(value), minWidth), maxWidth)
}

function readStoredNewThreadIncludeDiffs() {
  if (typeof window === "undefined") {
    return false
  }

  try {
    return window.localStorage.getItem(NEW_THREAD_INCLUDE_DIFFS_STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function getPathBasename(filePath: string) {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath
}

function formatProjectFilterLabel(projectPath: string) {
  return getPathBasename(projectPath) || projectPath
}

function formatComposerProviderLabel(provider: ThreadLaunchVendor) {
  return getComposerProviderConfig(provider).label
}

function formatLaunchModeLabel(launchMode: ThreadLaunchMode) {
  return launchMode === "app" ? "App" : "CLI"
}

function getDefaultLaunchModeFromClient(sessionClient?: SessionClient) {
  return sessionClient === "desktop" ? "app" : "cli"
}

function formatThinkingLevelLabel(thinkingLevel: ThinkingLevel) {
  return (
    THINKING_LEVEL_OPTIONS.find(option => option.value === thinkingLevel)?.label ??
    thinkingLevel
  )
}

function formatComposerOptionsSummary(
  draft: Pick<NewThreadDraft, "vendor" | "thinkingLevel" | "fast">
) {
  const thinkingLabel = formatThinkingLevelLabel(draft.thinkingLevel)
  return draft.vendor === "codex" && draft.fast
    ? `${thinkingLabel} · Fast`
    : thinkingLabel
}

function createDefaultNewThreadDraft(): NewThreadDraft {
  return {
    sourceSessionId: null,
    projectPath: null,
    includeDiffs: readStoredNewThreadIncludeDiffs(),
    vendor: "codex",
    launchMode: getDefaultComposerLaunchMode("codex"),
    modelId: getDefaultComposerModelId("codex"),
    thinkingLevel: "high",
    fast: false,
    prompt: ""
  }
}

function getSeededNewThreadTarget(params: {
  provider: ThreadLaunchVendor
  sessionClient?: SessionClient
  fast: boolean
}) {
  return normalizeComposerTarget({
    provider: params.provider,
    launchMode:
      params.provider === "codex"
        ? getDefaultLaunchModeFromClient(params.sessionClient)
        : getDefaultComposerLaunchMode(params.provider),
    modelId: getDefaultComposerModelId(params.provider),
    fast: params.fast
  })
}

function getFilterOptionLabel<TValue extends string>(
  options: Array<{ label: string; value: TValue }>,
  value: TValue
) {
  return options.find(option => option.value === value)?.label ?? value
}

function formatProjectSummary(
  selectedProjectPaths: string[],
  projectOptions: ProjectFilterOption[]
) {
  if (selectedProjectPaths.length === 0) {
    return "All"
  }

  if (selectedProjectPaths.length === 1) {
    return (
      projectOptions.find(option => option.path === selectedProjectPaths[0])?.label ??
      formatProjectFilterLabel(selectedProjectPaths[0])
    )
  }

  return `${selectedProjectPaths.length} selected`
}

function createDefaultThreadOrganization(): ThreadOrganizationSettings {
  return {
    viewMode: DEFAULT_THREAD_ORGANIZATION.viewMode,
    sortKey: DEFAULT_THREAD_ORGANIZATION.sortKey,
    projects: {},
    collections: []
  }
}

function cloneThreadOrganization(
  organization: ThreadOrganizationSettings
): ThreadOrganizationSettings {
  return {
    viewMode: organization.viewMode,
    sortKey: organization.sortKey,
    projects: Object.fromEntries(
      Object.entries(organization.projects).map(([projectPath, state]) => [
        projectPath,
        {
          ...state,
          threadOrder: [...state.threadOrder]
        }
      ])
    ),
    collections: organization.collections.map(collection => ({
      ...collection,
      threadIds: [...collection.threadIds]
    }))
  }
}

function getSessionSortTimestamp(session: SessionListItem, sortKey: ThreadSortKey) {
  const value = sortKey === "created" ? session.createdAt : session.updatedAt
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function sortSessionsByThreadKey(
  sessions: SessionListItem[],
  sortKey: ThreadSortKey
) {
  return [...sessions].sort((left, right) => {
    const timestampDiff =
      getSessionSortTimestamp(right, sortKey) - getSessionSortTimestamp(left, sortKey)
    if (timestampDiff !== 0) {
      return timestampDiff
    }

    return right.updatedAt.localeCompare(left.updatedAt) || left.threadName.localeCompare(right.threadName)
  })
}

function orderSessionsWithManualOrder(
  sessions: SessionListItem[],
  threadOrder: string[],
  sortKey: ThreadSortKey
) {
  const byId = new Map(sessions.map(session => [session.id, session]))
  const orderedSessions = threadOrder
    .map(sessionId => byId.get(sessionId) ?? null)
    .filter((session): session is SessionListItem => session !== null)
  const seenSessionIds = new Set(orderedSessions.map(session => session.id))
  const remainingSessions = sortSessionsByThreadKey(
    sessions.filter(session => !seenSessionIds.has(session.id)),
    sortKey
  )

  return [...orderedSessions, ...remainingSessions]
}

function moveItemWithPosition<T>(
  items: T[],
  fromIndex: number,
  toIndex: number,
  position: "before" | "after"
) {
  if (fromIndex === -1 || toIndex === -1) {
    return items
  }

  const nextItems = [...items]
  const [movedItem] = nextItems.splice(fromIndex, 1)
  let insertionIndex = toIndex

  if (fromIndex < toIndex) {
    insertionIndex -= 1
  }

  if (position === "after") {
    insertionIndex += 1
  }

  nextItems.splice(Math.max(0, insertionIndex), 0, movedItem)
  return nextItems
}

function mergeVisibleOrderWithHiddenIds(
  existingIds: string[],
  visibleIds: string[]
) {
  const visibleIdSet = new Set(visibleIds)
  const hiddenIds = existingIds.filter(id => !visibleIdSet.has(id))
  return [...visibleIds, ...hiddenIds.filter(id => !visibleIds.includes(id))]
}

function getProjectLabel(
  projectPath: string,
  organization: ThreadOrganizationSettings
) {
  const alias = organization.projects[projectPath]?.alias?.trim() ?? ""
  return alias || formatProjectFilterLabel(projectPath)
}

function getCollectionMembershipMap(collections: ThreadCollection[]) {
  const membershipMap = new Map<string, Set<string>>()

  for (const collection of collections) {
    for (const threadId of collection.threadIds) {
      const membership = membershipMap.get(threadId) ?? new Set<string>()
      membership.add(collection.id)
      membershipMap.set(threadId, membership)
    }
  }

  return membershipMap
}

function buildProjectSidebarGroups(params: {
  sessions: SessionListItem[]
  organization: ThreadOrganizationSettings
}) {
  const groupEntries = new Map<string, SessionListItem[]>()
  for (const session of params.sessions) {
    const groupId = session.projectPath ?? NO_PROJECT_GROUP_ID
    const groupSessions = groupEntries.get(groupId) ?? []
    groupSessions.push(session)
    groupEntries.set(groupId, groupSessions)
  }

  const projectGroups: ThreadSidebarGroup[] = []
  let noProjectGroup: ThreadSidebarGroup | null = null

  for (const [groupId, sessions] of groupEntries) {
    if (groupId === NO_PROJECT_GROUP_ID) {
      noProjectGroup = {
        id: NO_PROJECT_GROUP_ID,
        kind: "system",
        title: "No project",
        subtitle: null,
        projectPath: null,
        collectionId: null,
        collapsed: false,
        sessions: sortSessionsByThreadKey(sessions, params.organization.sortKey),
        canRename: false,
        canDelete: false,
        canReorder: false
      }
      continue
    }

    const projectState = params.organization.projects[groupId]
    const orderedSessions = orderSessionsWithManualOrder(
      sessions,
      projectState?.threadOrder ?? [],
      params.organization.sortKey
    )

    projectGroups.push({
      id: groupId,
      kind: "project",
      title: getProjectLabel(groupId, params.organization),
      subtitle: groupId,
      projectPath: groupId,
      collectionId: null,
      collapsed: projectState?.collapsed ?? false,
      sessions: orderedSessions,
      canRename: true,
      canDelete: false,
      canReorder: true
    })
  }

  const manualProjectGroups = projectGroups
    .filter(group => {
      const order = group.projectPath ? params.organization.projects[group.projectPath]?.order : null
      return order !== null && order !== undefined
    })
    .sort((left, right) => {
      const leftOrder = left.projectPath ? params.organization.projects[left.projectPath]?.order ?? 0 : 0
      const rightOrder = right.projectPath ? params.organization.projects[right.projectPath]?.order ?? 0 : 0
      return leftOrder - rightOrder || left.title.localeCompare(right.title)
    })
  const manualGroupIds = new Set(manualProjectGroups.map(group => group.id))
  const unorderedProjectGroups = projectGroups
    .filter(group => !manualGroupIds.has(group.id))
    .sort((left, right) => {
      const leftSession = left.sessions[0]
      const rightSession = right.sessions[0]
      if (!leftSession || !rightSession) {
        return left.title.localeCompare(right.title)
      }

      const timestampDiff =
        getSessionSortTimestamp(rightSession, params.organization.sortKey) -
        getSessionSortTimestamp(leftSession, params.organization.sortKey)
      return timestampDiff !== 0 ? timestampDiff : left.title.localeCompare(right.title)
    })

  return [...manualProjectGroups, ...unorderedProjectGroups, ...(noProjectGroup ? [noProjectGroup] : [])]
}

function buildCollectionSidebarGroups(params: {
  sessions: SessionListItem[]
  organization: ThreadOrganizationSettings
}) {
  const sessionById = new Map(params.sessions.map(session => [session.id, session]))
  const membershipMap = getCollectionMembershipMap(params.organization.collections)

  const collectionGroups = params.organization.collections.flatMap(collection => {
      const visibleSessions = collection.threadIds
        .map(threadId => sessionById.get(threadId) ?? null)
        .filter((session): session is SessionListItem => session !== null)

      return [
        {
          id: collection.id,
          kind: "collection" as const,
          title: collection.name,
          subtitle: null,
          projectPath: null,
          collectionId: collection.id,
          collapsed: collection.collapsed,
          sessions: orderSessionsWithManualOrder(
            visibleSessions,
            collection.threadIds,
            params.organization.sortKey
          ),
          canRename: true,
          canDelete: true,
          canReorder: true,
          collectionIcon: collection.icon,
          collectionColor: collection.color
        } satisfies ThreadSidebarGroup
      ]
    })

  const manualCollectionGroups = collectionGroups
    .filter(group => {
      const order =
        params.organization.collections.find(collection => collection.id === group.id)?.order ?? null
      return order !== null && order !== undefined
    })
    .sort((left, right) => {
      const leftOrder =
        params.organization.collections.find(collection => collection.id === left.id)?.order ?? 0
      const rightOrder =
        params.organization.collections.find(collection => collection.id === right.id)?.order ?? 0
      return leftOrder - rightOrder || left.title.localeCompare(right.title)
    })
  const manualCollectionIds = new Set(manualCollectionGroups.map(group => group.id))
  const unorderedCollectionGroups = collectionGroups
    .filter(group => !manualCollectionIds.has(group.id))
    .sort((left, right) => {
      const leftSession = left.sessions[0]
      const rightSession = right.sessions[0]
      if (!leftSession || !rightSession) {
        return left.title.localeCompare(right.title)
      }

      const timestampDiff =
        getSessionSortTimestamp(rightSession, params.organization.sortKey) -
        getSessionSortTimestamp(leftSession, params.organization.sortKey)
      return timestampDiff !== 0 ? timestampDiff : left.title.localeCompare(right.title)
    })

  const unassignedSessions = params.sessions.filter(session => {
    const membership = membershipMap.get(session.id)
    return !membership || membership.size === 0
  })
  const unassignedGroup =
    unassignedSessions.length > 0
      ? ({
          id: UNASSIGNED_COLLECTION_GROUP_ID,
          kind: "system" as const,
          title: "Unassigned",
          subtitle: null,
          projectPath: null,
          collectionId: null,
          collapsed: false,
          sessions: sortSessionsByThreadKey(unassignedSessions, params.organization.sortKey),
          canRename: false,
          canDelete: false,
          canReorder: false
        } satisfies ThreadSidebarGroup)
      : null

  return [
    ...manualCollectionGroups,
    ...unorderedCollectionGroups,
    ...(unassignedGroup ? [unassignedGroup] : [])
  ]
}

function buildUniqueCollectionName(
  collections: ThreadCollection[],
  baseName: string
) {
  const trimmedBaseName = baseName.trim() || "New collection"
  const normalizedNames = new Set(
    collections.map(collection => collection.name.trim().toLowerCase()).filter(Boolean)
  )

  if (!normalizedNames.has(trimmedBaseName.toLowerCase())) {
    return trimmedBaseName
  }

  let suffix = 2
  while (normalizedNames.has(`${trimmedBaseName} ${suffix}`.toLowerCase())) {
    suffix += 1
  }

  return `${trimmedBaseName} ${suffix}`
}

function resequenceProjectOrders(
  organization: ThreadOrganizationSettings,
  orderedProjectPaths: string[]
) {
  const remainingProjectPaths = Object.values(organization.projects)
    .filter(project => project.order !== null && !orderedProjectPaths.includes(project.projectPath))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map(project => project.projectPath)
  const nextProjects = { ...organization.projects }

  ;[...orderedProjectPaths, ...remainingProjectPaths].forEach((projectPath, index) => {
    const currentState = nextProjects[projectPath] ?? {
      projectPath,
      alias: "",
      collapsed: false,
      order: null,
      threadOrder: []
    }
    nextProjects[projectPath] = {
      ...currentState,
      order: index
    }
  })

  return {
    ...organization,
    projects: nextProjects
  }
}

function resequenceCollectionOrders(
  organization: ThreadOrganizationSettings,
  orderedCollectionIds: string[]
) {
  const remainingCollections = organization.collections
    .filter(collection => !orderedCollectionIds.includes(collection.id))
    .sort((left, right) => {
      if (left.order !== null && right.order !== null) {
        return left.order - right.order || left.name.localeCompare(right.name)
      }

      if (left.order !== null) {
        return -1
      }

      if (right.order !== null) {
        return 1
      }

      return left.name.localeCompare(right.name)
    })
    .map(collection => collection.id)

  const nextOrder = [...orderedCollectionIds, ...remainingCollections]
  return {
    ...organization,
    collections: nextOrder.flatMap((collectionId, index) => {
      const collection = organization.collections.find(entry => entry.id === collectionId)
      return collection
        ? [
            {
              ...collection,
              order: index
            }
          ]
        : []
    })
  }
}

function getVerticalDropPosition(event: ReactDragEvent<HTMLElement>) {
  const bounds = event.currentTarget.getBoundingClientRect()
  return event.clientY - bounds.top < bounds.height / 2 ? "before" : "after"
}

function escapeStructuredValue(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function buildNewThreadPrompt(params: {
  projectPath: string | null
  session: SessionListItem | null
  transcript: ConversationTranscript | null
  draft: Pick<NewThreadDraft, "includeDiffs" | "prompt">
}) {
  const { draft, projectPath, session, transcript } = params
  const trimmedInstructions = draft.prompt.trim()
  const parts = [`<handoff_thread_prompt>`]

  if (projectPath) {
    parts.push(`  <project_path>${escapeStructuredValue(projectPath)}</project_path>`)
  }

  if (session && transcript) {
    parts.push(
      `  <source_thread provider="${transcript.provider}" archived="${
        transcript.archived ? "true" : "false"
      }">`
    )
    parts.push(`    <thread_name>${escapeStructuredValue(transcript.threadName)}</thread_name>`)
    parts.push(`    <updated_at>${escapeStructuredValue(transcript.updatedAt)}</updated_at>`)
    parts.push(`    <messages>`)

    transcript.entries.forEach(entry => {
      if (entry.kind === "thought_chain") {
        parts.push(`      <thought_chain>`)
        entry.messages.forEach(message => {
          parts.push(`        <step format="markdown">`)
          parts.push(escapeStructuredValue(message.bodyMarkdown))
          parts.push(`        </step>`)
        })
        parts.push(`      </thought_chain>`)
        return
      }

      parts.push(`      <message role="${entry.role}">`)
      parts.push(`        <timestamp>${escapeStructuredValue(entry.timestamp)}</timestamp>`)
      parts.push(`        <content format="markdown">`)
      parts.push(escapeStructuredValue(entry.bodyMarkdown))
      parts.push(`        </content>`)

      if (draft.includeDiffs && entry.role === "assistant" && entry.patches.length > 0) {
        parts.push(`        <diffs>`)
        entry.patches.forEach(patch => {
          parts.push(`          <diff>`)
          parts.push(
            `            <files>${escapeStructuredValue(
              patch.files.length > 0 ? patch.files.join(", ") : "unknown files"
            )}</files>`
          )
          parts.push(`            <patch format="diff">`)
          parts.push(escapeStructuredValue(patch.patch))
          parts.push(`            </patch>`)
          parts.push(`          </diff>`)
        })
        parts.push(`        </diffs>`)
      }

      parts.push(`      </message>`)
    })

    parts.push(`    </messages>`)
    parts.push(`  </source_thread>`)
  }

  if (trimmedInstructions) {
    parts.push(`  <additional_instructions format="markdown">`)
    parts.push(escapeStructuredValue(trimmedInstructions))
    parts.push(`  </additional_instructions>`)
  }

  if (parts.length === 1) {
    return ""
  }

  parts.push(`</handoff_thread_prompt>`)
  return `${parts.join("\n")}\n`
}

function buildNewThreadStartLabel(draft: Pick<NewThreadDraft, "launchMode" | "vendor">) {
  const providerLabel = formatComposerProviderLabel(draft.vendor)
  if (draft.vendor === "claude") {
    return `Start in ${providerLabel}`
  }

  if (draft.launchMode === "app") {
    return `Copy + Open in ${providerLabel}`
  }

  return `Start in ${providerLabel} ${formatLaunchModeLabel(draft.launchMode)}`
}

function sortAgentsByName(agents: AgentDefinition[]) {
  return [...agents].sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.id.localeCompare(right.id)
  )
}

function cloneAgentDefinition(agent: AgentDefinition | null) {
  return agent ? { ...agent } : null
}

function areAgentsEqual(left: AgentDefinition | null, right: AgentDefinition | null) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sortAgentRunsByStartedAt(runs: AgentRunRecord[]) {
  return [...runs].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt)
  )
}

function formatAgentRunStatus(status: AgentRunRecord["status"]) {
  if (status === "completed") {
    return "Completed"
  }

  if (status === "failed") {
    return "Failed"
  }

  if (status === "canceled") {
    return "Canceled"
  }

  return "Running"
}

function formatSkillInstallState(params: {
  skillInstalled: boolean
  mcpInstalled: boolean
}) {
  if (params.skillInstalled && params.mcpInstalled) {
    return "Installed"
  }

  if (params.skillInstalled || params.mcpInstalled) {
    return "Partial"
  }

  return "Not installed"
}

type AgentsPaneView = "dashboard" | "agent" | "automation"

function getAgentRunProjectLabel(projectPath: string) {
  return formatProjectFilterLabel(projectPath)
}

function getAgentRunThreadLabel(run: AgentRunRecord) {
  if (run.caller && typeof run.caller === "object") {
    const sessionName =
      typeof run.caller.sessionName === "string" ? run.caller.sessionName.trim() : ""
    const threadName =
      typeof run.caller.threadName === "string" ? run.caller.threadName.trim() : ""
    const threadId =
      typeof run.caller.threadId === "string" ? run.caller.threadId.trim() : ""

    const primaryName = sessionName || threadName

    if (primaryName && threadId) {
      return `${primaryName} · ${threadId}`
    }

    if (primaryName || threadId) {
      return primaryName || threadId
    }
  }

  return run.runId
}

function getAgentRunHistoryLabel(run: AgentRunRecord) {
  const threadLabel = getAgentRunThreadLabel(run)
  return threadLabel === run.runId
    ? getComposerModelLabel(run.provider, run.modelId)
    : threadLabel
}

function formatAgentRunAge(startedAt: string, now: number) {
  const startedAtMs = Date.parse(startedAt)
  if (Number.isNaN(startedAtMs)) {
    return null
  }

  const diffMs = Math.max(0, now - startedAtMs)
  const minuteMs = 60 * 1000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  const weekMs = 7 * dayMs
  const monthMs = 30 * dayMs

  if (diffMs < hourMs) {
    return `${Math.max(1, Math.floor(diffMs / minuteMs))}m`
  }

  if (diffMs < dayMs) {
    return `${Math.max(1, Math.floor(diffMs / hourMs))}h`
  }

  if (diffMs < weekMs) {
    return `${Math.max(1, Math.floor(diffMs / dayMs))}d`
  }

  if (diffMs < monthMs) {
    return `${Math.max(1, Math.floor(diffMs / weekMs))}w`
  }

  return `${Math.max(1, Math.floor(diffMs / monthMs))}m`
}

function getAgentRunResultLabel(run: AgentRunRecord) {
  if (run.status === "completed") {
    return "Final response"
  }

  return "Error"
}

function getAutomationStatusTone(params: {
  bridgeStatus?: AgentBridgeHealth | null
  providerStatus?: HandoffSkillsStatus["providers"][SessionProvider]
}) {
  if (params.bridgeStatus) {
    return params.bridgeStatus.status === "ready" ? "ready" : "error"
  }

  if (!params.providerStatus) {
    return "partial"
  }

  if (params.providerStatus.skillInstalled && params.providerStatus.mcpInstalled) {
    return "ready"
  }

  if (params.providerStatus.skillInstalled || params.providerStatus.mcpInstalled) {
    return "partial"
  }

  return "error"
}

function buildMarkdownExport(
  transcript: ConversationTranscript,
  includeDiffs: boolean
) {
  const parts: string[] = []

  transcript.entries.forEach(entry => {
    if (entry.kind !== "message") {
      return
    }

    parts.push(`## ${entry.role === "assistant" ? "Assistant" : "User"}`)
    parts.push(entry.bodyMarkdown)

    if (includeDiffs && entry.role === "assistant" && entry.patches.length > 0) {
      parts.push("### Diffs")
      entry.patches.forEach((patch, patchIndex) => {
        parts.push(`#### Patch ${patchIndex + 1}`)
        parts.push(`Files: ${patch.files.length > 0 ? patch.files.join(", ") : "unknown files"}`)
        parts.push(`\`\`\`diff\n${patch.patch}\n\`\`\``)
      })
    }
  })

  return `${parts.join("\n\n").trim()}\n`
}

function getLastAssistantEntry(transcript: ConversationTranscript) {
  for (let index = transcript.entries.length - 1; index >= 0; index -= 1) {
    const entry = transcript.entries[index]
    if (entry.kind === "message" && entry.role === "assistant") {
      return entry
    }
  }

  return null
}

function buildConversationPayload(
  transcript: ConversationTranscript,
  includeDiffs: boolean
) {
  return {
    type: "conversation",
    threadName: transcript.threadName,
    provider: transcript.provider,
    archived: transcript.archived,
    updatedAt: transcript.updatedAt,
    projectPath: transcript.projectPath ?? transcript.sessionCwd ?? null,
    messages: transcript.entries.flatMap(entry => {
      if (entry.kind !== "message") {
        return []
      }

      return [
        {
          role: entry.role,
          timestamp: entry.timestamp,
          markdown: entry.bodyMarkdown,
          ...(entry.role === "assistant" && includeDiffs && entry.patches.length > 0
            ? {
                patches: entry.patches.map(patch => ({
                  files: patch.files,
                  patch: patch.patch
                }))
              }
            : {})
        }
      ]
    })
  }
}

function buildLastAssistantPayload(transcript: ConversationTranscript) {
  const entry = getLastAssistantEntry(transcript)

  return {
    type: "assistant_message",
    threadName: transcript.threadName,
    provider: transcript.provider,
    archived: transcript.archived,
    updatedAt: transcript.updatedAt,
    projectPath: transcript.projectPath ?? transcript.sessionCwd ?? null,
    message: entry
      ? {
          role: "assistant" as const,
          timestamp: entry.timestamp,
          markdown: entry.bodyMarkdown
        }
      : null
  }
}

function buildStructuredConversationExport(
  transcript: ConversationTranscript,
  includeDiffs: boolean
) {
  const payload = buildConversationPayload(transcript, includeDiffs)
  const parts = [
    `<conversation_thread provider="${payload.provider}" archived="${payload.archived ? "true" : "false"}">`,
    `  <thread_name>${escapeStructuredValue(payload.threadName)}</thread_name>`,
    `  <updated_at>${escapeStructuredValue(payload.updatedAt)}</updated_at>`
  ]

  if (payload.projectPath) {
    parts.push(`  <project_path>${escapeStructuredValue(payload.projectPath)}</project_path>`)
  }

  parts.push("  <messages>")

  payload.messages.forEach(message => {
    parts.push(`    <message role="${message.role}">`)
    parts.push(`      <timestamp>${escapeStructuredValue(message.timestamp)}</timestamp>`)
    parts.push("      <content format=\"markdown\">")
    parts.push(escapeStructuredValue(message.markdown))
    parts.push("      </content>")

    if ("patches" in message && message.patches) {
      parts.push("      <diffs>")
      message.patches.forEach(patch => {
        parts.push("        <diff>")
        parts.push(
          `          <files>${escapeStructuredValue(
            patch.files.length > 0 ? patch.files.join(", ") : "unknown files"
          )}</files>`
        )
        parts.push("          <patch format=\"diff\">")
        parts.push(escapeStructuredValue(patch.patch))
        parts.push("          </patch>")
        parts.push("        </diff>")
      })
      parts.push("      </diffs>")
    }

    parts.push("    </message>")
  })

  parts.push("  </messages>")
  parts.push("</conversation_thread>")

  return `${parts.join("\n")}\n`
}

function buildStructuredLastMessageExport(transcript: ConversationTranscript) {
  const payload = buildLastAssistantPayload(transcript)
  const parts = [
    `<assistant_response provider="${payload.provider}" archived="${payload.archived ? "true" : "false"}">`,
    `  <thread_name>${escapeStructuredValue(payload.threadName)}</thread_name>`,
    `  <updated_at>${escapeStructuredValue(payload.updatedAt)}</updated_at>`
  ]

  if (payload.projectPath) {
    parts.push(`  <project_path>${escapeStructuredValue(payload.projectPath)}</project_path>`)
  }

  if (payload.message) {
    parts.push(`  <timestamp>${escapeStructuredValue(payload.message.timestamp)}</timestamp>`)
    parts.push("  <content format=\"markdown\">")
    parts.push(escapeStructuredValue(payload.message.markdown))
    parts.push("  </content>")
  }

  parts.push("</assistant_response>")
  return `${parts.join("\n")}\n`
}

function serializeConversationOutput(
  transcript: ConversationTranscript,
  format: OutputFormatKey,
  action: CopyActionKey
) {
  if (action === "last-message") {
    if (!transcript.lastAssistantMarkdown) {
      return ""
    }

    if (format === "markdown") {
      return `${transcript.lastAssistantMarkdown.trim()}\n`
    }

    if (format === "json") {
      return `${JSON.stringify(buildLastAssistantPayload(transcript), null, 2)}\n`
    }

    return buildStructuredLastMessageExport(transcript)
  }

  const includeDiffs = action === "chat-with-diffs"

  if (format === "markdown") {
    return buildMarkdownExport(transcript, includeDiffs)
  }

  if (format === "json") {
    return `${JSON.stringify(buildConversationPayload(transcript, includeDiffs), null, 2)}\n`
  }

  return buildStructuredConversationExport(transcript, includeDiffs)
}

function isDefaultSearchFilters(filters: SearchFilters) {
  return (
    filters.archived === DEFAULT_SEARCH_FILTERS.archived &&
    filters.provider === DEFAULT_SEARCH_FILTERS.provider &&
    filters.dateRange === DEFAULT_SEARCH_FILTERS.dateRange &&
    filters.projectPaths.length === 0
  )
}

function isDefaultSidebarFilters(filters: SearchFilters) {
  return (
    filters.archived === DEFAULT_SIDEBAR_FILTERS.archived &&
    filters.provider === DEFAULT_SIDEBAR_FILTERS.provider &&
    filters.dateRange === DEFAULT_SIDEBAR_FILTERS.dateRange &&
    filters.projectPaths.length === 0
  )
}

function matchesArchivedFilter(
  session: SessionListItem,
  archivedFilter: ArchivedFilterValue
) {
  if (archivedFilter === "all") {
    return true
  }

  return archivedFilter === "archived" ? session.archived : !session.archived
}

function matchesProviderFilter(
  session: SessionListItem,
  providerFilter: ProviderFilterValue
) {
  return providerFilter === "all" ? true : session.provider === providerFilter
}

function matchesDateFilter(
  session: SessionListItem,
  dateFilter: DateRangeFilterValue,
  now: number
) {
  if (dateFilter === "all") {
    return true
  }

  const updatedAtMs = Date.parse(session.updatedAt)
  if (Number.isNaN(updatedAtMs)) {
    return false
  }

  const maxAgeMs =
    dateFilter === "24h"
      ? 24 * 60 * 60 * 1000
      : dateFilter === "3d"
        ? 3 * 24 * 60 * 60 * 1000
        : dateFilter === "7d"
          ? 7 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000

  return updatedAtMs >= now - maxAgeMs
}

function FilterIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M2.5 3.25h11l-4.1 4.68v3.1l-2.8 1.72V7.93L2.5 3.25Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function SortIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M3 4.25h10M5 8h8M7 11.75h6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function NewCollectionIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M2.75 4.75h3.5l1.1 1.3h5.9v5.45a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-6.75Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.15"
      />
      <path
        d="M11.25 3.25v3M9.75 4.75h3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.15"
      />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M2.75 4.75h3.5l1.1 1.3h5.9v5.45a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-6.75Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.15"
      />
    </svg>
  )
}

function CollectionIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <rect
        height="7.25"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.1"
        width="7.25"
        x="2.25"
        y="3.25"
      />
      <rect
        height="7.25"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.1"
        width="7.25"
        x="6.5"
        y="5.5"
      />
    </svg>
  )
}

function BookmarkIcon() {
  return (
    <svg aria-hidden="true" className="sidebar-filter-icon" fill="none" viewBox="0 0 16 16">
      <path
        d="M4.25 2.75h7.5v10.5L8 10.6l-3.75 2.65V2.75Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.1"
      />
    </svg>
  )
}

function StarIcon() {
  return (
    <svg aria-hidden="true" className="sidebar-filter-icon" fill="none" viewBox="0 0 16 16">
      <path
        d="m8 2.75 1.55 3.15 3.48.5-2.52 2.45.6 3.45L8 10.7l-3.11 1.6.6-3.45L2.97 6.4l3.48-.5L8 2.75Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.05"
      />
    </svg>
  )
}

function BoltIcon() {
  return (
    <svg aria-hidden="true" className="sidebar-filter-icon" fill="none" viewBox="0 0 16 16">
      <path
        d="M8.9 2.75 4.9 8.1h2.55l-.35 5.15 4-5.35H8.55l.35-5.15Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.1"
      />
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg aria-hidden="true" className="sidebar-filter-icon" fill="none" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.05" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.05" />
      <path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.05" />
    </svg>
  )
}

function BriefcaseIcon() {
  return (
    <svg aria-hidden="true" className="sidebar-filter-icon" fill="none" viewBox="0 0 16 16">
      <path
        d="M5.4 4.25V3.4c0-.36.29-.65.65-.65h3.9c.36 0 .65.29.65.65v.85M2.75 5.25h10.5v6a1 1 0 0 1-1 1H3.75a1 1 0 0 1-1-1v-6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.1"
      />
      <path d="M2.75 7.35h10.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function resolveCollectionIcon(icon: ThreadCollection["icon"] | null | undefined): ThreadCollectionIcon {
  return icon ?? DEFAULT_THREAD_COLLECTION_ICON
}

function resolveCollectionColor(color: string | null | undefined) {
  return color?.trim() || DEFAULT_THREAD_COLLECTION_COLOR
}

function CollectionSymbol({
  icon
}: {
  icon?: ThreadCollection["icon"] | null
}) {
  switch (resolveCollectionIcon(icon)) {
    case "bookmark":
      return <BookmarkIcon />
    case "star":
      return <StarIcon />
    case "bolt":
      return <BoltIcon />
    case "target":
      return <TargetIcon />
    case "briefcase":
      return <BriefcaseIcon />
    case "stack":
    default:
      return <CollectionIcon />
  }
}

function EllipsisIcon() {
  return (
    <svg aria-hidden="true" className="sidebar-filter-icon" fill="currentColor" viewBox="0 0 16 16">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.3 10.3 13.5 13.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function WriteIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M10.85 2.35a1.2 1.2 0 0 1 1.7 0l1.1 1.1a1.2 1.2 0 0 1 0 1.7l-7.2 7.2-2.9.6.6-2.9 7.2-7.2Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.15"
      />
      <path
        d="m9.65 3.55 2.8 2.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.15"
      />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M6.45 2.35h3.1l.35 1.55a4.45 4.45 0 0 1 1.06.61l1.47-.63 1.55 2.68-1.12 1.12c.07.39.07.79 0 1.18l1.12 1.12-1.55 2.68-1.47-.63c-.33.24-.69.44-1.06.61l-.35 1.55h-3.1l-.35-1.55a4.45 4.45 0 0 1-1.06-.61l-1.47.63-1.55-2.68 1.12-1.12a3.94 3.94 0 0 1 0-1.18L2.85 6.56 4.4 3.88l1.47.63c.33-.24.69-.44 1.06-.61l.35-1.55Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.05"
      />
      <circle cx="8" cy="8" r="1.85" stroke="currentColor" strokeWidth="1.05" />
    </svg>
  )
}

function BackArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M6.25 3.5 2.75 8l3.5 4.5M3.25 8h10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function ThreadsIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M3 4.25h10M3 8h10M3 11.75h10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function AgentsIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <circle cx="8" cy="5.2" r="2.1" stroke="currentColor" strokeWidth="1.15" />
      <path
        d="M3.75 12.75c.42-2.1 2.02-3.25 4.25-3.25s3.83 1.15 4.25 3.25"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.15"
      />
    </svg>
  )
}

function DashboardIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M2.75 2.75h4.5v4.5h-4.5ZM8.75 2.75h4.5v2.5h-4.5ZM8.75 6.75h4.5v6.5h-4.5ZM2.75 8.75h4.5v4.5h-4.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.1"
      />
    </svg>
  )
}

function StatusMarkerIcon({
  state
}: {
  state: "ready" | "partial" | "error"
}) {
  return (
    <span className={`automation-status-icon is-${state}`} aria-hidden="true">
      {state === "ready" ? "✓" : state === "partial" ? "–" : "✕"}
    </span>
  )
}

function SelectorIcon() {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-filter-icon"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M8 2.75 12.75 5.5v5L8 13.25 3.25 10.5v-5L8 2.75Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.15"
      />
      <path
        d="M8 2.75v10.5M3.25 5.5 8 8.25l4.75-2.75"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.05"
      />
    </svg>
  )
}

function ChevronDownIcon({ isOpen = false }: { isOpen?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`filter-menu-chevron ${isOpen ? "is-open" : ""}`}
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="m4.25 6.25 3.75 3.75 3.75-3.75"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </svg>
  )
}

function CopyChevronIcon({ isOpen = false }: { isOpen?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`copy-chevron-icon ${isOpen ? "is-open" : ""}`}
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d={isOpen ? "m4.25 6.25 3.75 3.75 3.75-3.75" : "m4.25 9.75 3.75-3.75 3.75 3.75"}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </svg>
  )
}

function OutputFormatIcon({
  format,
  className
}: {
  format: OutputFormatKey
  className?: string
}) {
  if (format === "json") {
    return (
      <svg
        aria-hidden="true"
        className={className}
        fill="none"
        viewBox="0 0 16 16"
      >
        <path
          d="M6 3.25c-1.5 0-2 1.15-2 2.5v.25c0 .88-.4 1.5-1.35 1.75.95.25 1.35.87 1.35 1.75v.25c0 1.35.5 2.5 2 2.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.15"
        />
        <path
          d="M10 3.25c1.5 0 2 1.15 2 2.5v.25c0 .88.4 1.5 1.35 1.75-.95.25-1.35.87-1.35 1.75v.25c0 1.35-.5 2.5-2 2.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.15"
        />
      </svg>
    )
  }

  if (format === "structured") {
    return (
      <svg
        aria-hidden="true"
        className={className}
        fill="none"
        viewBox="0 0 16 16"
      >
        <path
          d="M6.25 3.5 2.75 8l3.5 4.5M9.75 3.5 13.25 8l-3.5 4.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.15"
        />
      </svg>
    )
  }

  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M3.5 4.25h9M3.5 8h9M3.5 11.75h5.25M4.75 2.75v10.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.15"
      />
    </svg>
  )
}

function readStoredSidebarWidth() {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_WIDTH
  }

  try {
    const rawValue = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (!rawValue) {
      return DEFAULT_SIDEBAR_WIDTH
    }

    const parsedValue = Number.parseInt(rawValue, 10)
    if (!Number.isFinite(parsedValue)) {
      return DEFAULT_SIDEBAR_WIDTH
    }

    return clampSidebarWidth(parsedValue, window.innerWidth)
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

function readStoredSidebarCollapsed() {
  if (typeof window === "undefined") {
    return false
  }

  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function highlightCodeHtml(content: string, language: string) {
  if (!content) {
    return "&nbsp;"
  }

  const grammar = Prism.languages[language]
  if (!grammar) {
    return escapeHtml(content)
  }

  return Prism.highlight(content, grammar, language)
}

const markdownComponents = {
  a({
    href,
    children
  }: {
    href?: string
    children?: ReactNode
  }) {
    if (!href) {
      return <span>{children}</span>
    }

    if (/^https?:\/\//.test(href)) {
      return (
        <a href={href} rel="noreferrer" target="_blank">
          {children}
        </a>
      )
    }

    return <span className="file-link">{children}</span>
  }
}

function EmptyState({
  title,
  detail
}: {
  title: string
  detail: string
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  )
}

function MarkdownBlock({
  markdown,
  className
}: {
  markdown: string
  className: string
}) {
  return (
    <div className={className}>
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

function DiffLine({
  line,
  language
}: {
  line: ParsedPatchLine
  language: string
}) {
  const symbol =
    line.type === "add" ? "+" : line.type === "remove" ? "-" : " "

  return (
    <div className={`diff-line diff-line-${line.type}`}>
      <span className="diff-line-symbol">{symbol}</span>
      <div
        className="diff-line-code"
        dangerouslySetInnerHTML={{
          __html: highlightCodeHtml(line.content, language)
        }}
      />
    </div>
  )
}

function PatchFileDiff({ file }: { file: ParsedPatchFile }) {
  const language = detectCodeLanguage(file.path)

  if (file.hunks.length === 0) {
    return (
      <div className="patch-file-diff-empty">
        {file.operation === "delete"
          ? "File deleted"
          : file.operation === "add"
            ? "File added"
            : "No line diff available"}
      </div>
    )
  }

  return (
    <div className="patch-file-diff">
      <div className="patch-file-diff-content">
        {file.hunks.map(hunk => (
          <div className="diff-hunk" key={hunk.id}>
            {hunk.header ? (
              <div className="diff-hunk-header">{`@@ ${hunk.header}`}</div>
            ) : null}
            <div className="diff-hunk-lines">
              {hunk.lines.map((line, index) => (
                <DiffLine
                  key={`${hunk.id}-${index + 1}`}
                  language={language}
                  line={line}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PatchPanel({ patches }: { patches: ConversationPatch[] }) {
  const summary = useMemo(
    () => parseApplyPatches(patches.map(patch => patch.patch)),
    [patches]
  )
  const [expandedFileId, setExpandedFileId] = useState<string | null>(null)

  if (summary.files.length === 0) {
    return null
  }

  return (
    <div className="patch-panel">
      <div className="patch-panel-header">
        <div className="patch-panel-summary">
          <span>
            {summary.files.length === 1
              ? "1 file changed"
              : `${summary.files.length} files changed`}
          </span>
          <span className="patch-additions">{formatAdditionCount(summary.additions)}</span>
          <span className="patch-deletions">{formatDeletionCount(summary.deletions)}</span>
        </div>
      </div>

      <div className="patch-file-list">
        {summary.files.map(file => {
          const isExpanded = expandedFileId === file.id

          return (
            <div className="patch-file-section" key={file.id}>
              <button
                aria-expanded={isExpanded}
                className="patch-file-toggle"
                onClick={() => {
                  setExpandedFileId(current => (current === file.id ? null : file.id))
                }}
                type="button"
              >
                <span className="patch-file-label-group">
                  <span className="patch-file-name">{file.path}</span>
                  {file.operation !== "update" ? (
                    <span className="patch-file-operation">{file.operation}</span>
                  ) : null}
                  <span className="patch-file-stats">
                    <span className="patch-additions">{formatAdditionCount(file.additions)}</span>
                    <span className="patch-deletions">{formatDeletionCount(file.deletions)}</span>
                  </span>
                </span>
                <span className={`patch-file-chevron ${isExpanded ? "is-open" : ""}`}>
                  &rsaquo;
                </span>
              </button>

              {isExpanded ? <PatchFileDiff file={file} /> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PatchList({ patches }: { patches: ConversationPatch[] }) {
  if (patches.length === 0) {
    return null
  }

  return <PatchPanel patches={patches} />
}

function ThoughtChain({
  entry,
  expanded,
  onToggle
}: {
  entry: AssistantThoughtChainEntry
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div className="conversation-entry thought-chain-entry">
      <button
        aria-expanded={expanded}
        className="thought-chain-toggle"
        onClick={onToggle}
        type="button"
      >
        <span className={`thought-chain-chevron ${expanded ? "is-open" : ""}`}>&rsaquo;</span>
        <span className="thought-chain-title">
          {`Thought chain (${entry.messageCount})`}
        </span>
        <span className="thought-chain-time">{formatTimestamp(entry.timestamp)}</span>
      </button>

      {expanded ? (
        <div className="thought-chain-body">
          {entry.messages.map(message => (
            <MarkdownBlock
              className="message-markdown thought-chain-markdown"
              key={message.id}
              markdown={message.bodyMarkdown}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function AssistantMessage({ entry }: { entry: AssistantMessageEntry }) {
  return (
    <div className="conversation-entry assistant-entry">
      <MarkdownBlock
        className="message-markdown assistant-markdown"
        markdown={entry.bodyMarkdown}
      />
      <PatchList patches={entry.patches} />
    </div>
  )
}

function FilterMenuRow({
  ariaLabel,
  filters,
  projectOptions,
  onArchivedChange,
  onProviderChange,
  onDateChange,
  onProjectToggle
}: {
  ariaLabel: string
  filters: SearchFilters
  projectOptions: ProjectFilterOption[]
  onArchivedChange(value: ArchivedFilterValue): void
  onProviderChange(value: ProviderFilterValue): void
  onDateChange(value: DateRangeFilterValue): void
  onProjectToggle(projectPath: string): void
}) {
  const [openMenuKey, setOpenMenuKey] = useState<FilterMenuKey | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!openMenuKey) {
      return () => undefined
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return
      }

      setOpenMenuKey(null)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenMenuKey(null)
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [openMenuKey])

  const triggerItems: Array<{
    key: FilterMenuKey
    label: string
    summary: string
  }> = [
    {
      key: "archived",
      label: "Archived",
      summary: getFilterOptionLabel(ARCHIVED_FILTER_OPTIONS, filters.archived)
    },
    {
      key: "provider",
      label: "Provider",
      summary: getFilterOptionLabel(PROVIDER_FILTER_OPTIONS, filters.provider)
    },
    {
      key: "project",
      label: "Project",
      summary: formatProjectSummary(filters.projectPaths, projectOptions)
    },
    {
      key: "date",
      label: "Date",
      summary: getFilterOptionLabel(DATE_FILTER_OPTIONS, filters.dateRange)
    }
  ]

  function renderPanel() {
    if (openMenuKey === "archived") {
      return (
        <div
          aria-label={`${ariaLabel} archived options`}
          className="filter-menu-panel"
          role="group"
        >
          {ARCHIVED_FILTER_OPTIONS.map(option => (
            <button
              className={`filter-menu-option ${
                filters.archived === option.value ? "is-selected" : ""
              }`}
              key={option.value}
              onClick={() => {
                onArchivedChange(option.value)
                setOpenMenuKey(null)
              }}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      )
    }

    if (openMenuKey === "provider") {
      return (
        <div
          aria-label={`${ariaLabel} provider options`}
          className="filter-menu-panel"
          role="group"
        >
          {PROVIDER_FILTER_OPTIONS.map(option => (
            <button
              className={`filter-menu-option ${
                filters.provider === option.value ? "is-selected" : ""
              }`}
              key={option.value}
              onClick={() => {
                onProviderChange(option.value)
                setOpenMenuKey(null)
              }}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      )
    }

    if (openMenuKey === "date") {
      return (
        <div
          aria-label={`${ariaLabel} date options`}
          className="filter-menu-panel"
          role="group"
        >
          {DATE_FILTER_OPTIONS.map(option => (
            <button
              className={`filter-menu-option ${
                filters.dateRange === option.value ? "is-selected" : ""
              }`}
              key={option.value}
              onClick={() => {
                onDateChange(option.value)
                setOpenMenuKey(null)
              }}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      )
    }

    if (openMenuKey === "project") {
      return (
        <div
          aria-label={`${ariaLabel} project options`}
          className="filter-menu-panel filter-menu-project-panel"
          role="group"
        >
          {projectOptions.length === 0 ? (
            <span className="filter-menu-empty">No projects available.</span>
          ) : (
            <div className="filter-menu-project-list">
              {projectOptions.map(option => (
                <label
                  className="filter-menu-project-option"
                  key={option.path}
                  title={option.path}
                >
                  <input
                    checked={filters.projectPaths.includes(option.path)}
                    onChange={() => onProjectToggle(option.path)}
                    type="checkbox"
                  />
                  <span className="filter-menu-project-copy">
                    <span className="filter-menu-project-name">{option.label}</span>
                    <span className="filter-menu-project-path">{option.path}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )
    }

    return null
  }

  return (
    <div className="filter-menu" ref={rootRef}>
      <div className="filter-menu-row">
        {triggerItems.map(item => (
          <button
            aria-expanded={openMenuKey === item.key}
            className={`filter-menu-trigger ${
              openMenuKey === item.key ? "is-open" : ""
            }`}
            key={item.key}
            onClick={() =>
              setOpenMenuKey(current => (current === item.key ? null : item.key))
            }
            type="button"
          >
            <span className="filter-menu-trigger-label">{item.label}</span>
            <span className="filter-menu-trigger-value">{item.summary}</span>
            <ChevronDownIcon isOpen={openMenuKey === item.key} />
          </button>
        ))}
      </div>

      {renderPanel()}
    </div>
  )
}

function SearchFilterBar({
  filters,
  projectOptions,
  onArchivedChange,
  onProviderChange,
  onDateChange,
  onProjectToggle
}: {
  filters: SearchFilters
  projectOptions: ProjectFilterOption[]
  onArchivedChange(value: ArchivedFilterValue): void
  onProviderChange(value: ProviderFilterValue): void
  onDateChange(value: DateRangeFilterValue): void
  onProjectToggle(projectPath: string): void
}) {
  return (
    <div className="search-filter-bar">
      <FilterMenuRow
        ariaLabel="Search filters"
        filters={filters}
        onArchivedChange={onArchivedChange}
        onDateChange={onDateChange}
        onProjectToggle={onProjectToggle}
        onProviderChange={onProviderChange}
        projectOptions={projectOptions}
      />
    </div>
  )
}

function SidebarFilterContent({
  filters,
  projectOptions,
  onArchivedChange,
  onProviderChange,
  onDateChange,
  onProjectToggle
}: {
  filters: SearchFilters
  projectOptions: ProjectFilterOption[]
  onArchivedChange(value: ArchivedFilterValue): void
  onProviderChange(value: ProviderFilterValue): void
  onDateChange(value: DateRangeFilterValue): void
  onProjectToggle(projectPath: string): void
}) {
  return (
    <FilterMenuRow
      ariaLabel="Session filters"
      filters={filters}
      onArchivedChange={onArchivedChange}
      onDateChange={onDateChange}
      onProjectToggle={onProjectToggle}
      onProviderChange={onProviderChange}
      projectOptions={projectOptions}
    />
  )
}

function ThreadOrganizeMenu({
  viewMode,
  sortKey,
  onViewModeChange,
  onSortKeyChange
}: {
  viewMode: ThreadViewMode
  sortKey: ThreadSortKey
  onViewModeChange(value: ThreadViewMode): void
  onSortKeyChange(value: ThreadSortKey): void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isOpen) {
      return () => undefined
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return
      }

      setIsOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false)
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOpen])

  return (
    <div className="thread-organize-menu" ref={rootRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="sidebar-filter-button sidebar-filter-list-button"
        onClick={() => setIsOpen(current => !current)}
        type="button"
      >
        <SortIcon />
        <span className="sidebar-filter-button-label">Organize</span>
      </button>

      {isOpen ? (
        <div className="thread-organize-popover" role="dialog">
          <div className="thread-organize-section">
            <span className="thread-organize-section-label">Organize</span>
            {THREAD_VIEW_MODE_OPTIONS.map(option => (
              <button
                className={`thread-organize-option ${
                  option.value === viewMode ? "is-selected" : ""
                }`}
                key={option.value}
                onClick={() => {
                  onViewModeChange(option.value)
                  setIsOpen(false)
                }}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="thread-organize-divider" />

          <div className="thread-organize-section">
            <span className="thread-organize-section-label">Sort by</span>
            {THREAD_SORT_KEY_OPTIONS.map(option => (
              <button
                className={`thread-organize-option ${
                  option.value === sortKey ? "is-selected" : ""
                }`}
                key={option.value}
                onClick={() => {
                  onSortKeyChange(option.value)
                  setIsOpen(false)
                }}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ThreadGroupMenuButton({
  kind,
  canDelete,
  onEditAppearance,
  onRename,
  onDelete
}: {
  kind: ThreadGroupMenuKind
  canDelete: boolean
  onEditAppearance?(): void
  onRename(): void
  onDelete?(): void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isOpen) {
      return () => undefined
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return
      }

      setIsOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false)
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOpen])

  return (
    <div className="thread-group-menu" ref={rootRef}>
      <button
        aria-label={`Open ${kind} actions`}
        className="thread-group-menu-trigger"
        onClick={event => {
          event.stopPropagation()
          setIsOpen(current => !current)
        }}
        onDragStart={event => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerDown={event => {
          event.stopPropagation()
        }}
        draggable={false}
        type="button"
      >
        <EllipsisIcon />
      </button>

      {isOpen ? (
        <div className="thread-group-menu-popover" role="menu">
          <button
            className="thread-group-menu-option"
            onClick={event => {
              event.stopPropagation()
              setIsOpen(false)
              onRename()
            }}
            type="button"
          >
            Rename
          </button>
          {kind === "collection" && onEditAppearance ? (
            <button
              className="thread-group-menu-option"
              onClick={event => {
                event.stopPropagation()
                setIsOpen(false)
                onEditAppearance()
              }}
              type="button"
            >
              Change color/icon
            </button>
          ) : null}
          {canDelete && onDelete ? (
            <button
              className="thread-group-menu-option is-danger"
              onClick={event => {
                event.stopPropagation()
                setIsOpen(false)
                onDelete()
              }}
              type="button"
            >
              Remove collection
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ThreadSessionRow({
  session,
  stateInfo,
  isActive,
  isGrouped,
  dropIndicator,
  onSelect,
  draggable = false,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop
}: {
  session: SessionListItem
  stateInfo: AppStateInfo | null
  isActive: boolean
  isGrouped: boolean
  dropIndicator?: "before" | "after" | null
  onSelect(): void
  draggable?: boolean
  onDragStart?(event: ReactDragEvent<HTMLDivElement>): void
  onDragEnd?(): void
  onDragOver?(event: ReactDragEvent<HTMLDivElement>): void
  onDrop?(event: ReactDragEvent<HTMLDivElement>): void
}) {
  return (
    <div
      className={`thread-tree-row ${isGrouped ? "is-grouped" : ""} ${
        dropIndicator ? `is-drop-${dropIndicator}` : ""
      }`}
      draggable={draggable}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragStart={onDragStart}
      onDrop={onDrop}
    >
      <button
        className={`session-row ${isActive ? "is-active" : ""}`}
        onClick={onSelect}
        type="button"
      >
        <div className="session-row-main">
          <div className="session-title-group">
            {session.archived ? (
              <span className="archived-indicator" title="Archived">
                A
              </span>
            ) : null}
            <span className="session-title">{session.threadName}</span>
          </div>
          <div className="session-row-meta">
            <ProviderIcon provider={session.provider} stateInfo={stateInfo} />
            <span className="session-time">
              {formatRelativeTimestamp(session.updatedAt)}
            </span>
          </div>
        </div>
        {!session.sessionPath ? (
          <span className="session-subtitle">Missing session file</span>
        ) : null}
      </button>
    </div>
  )
}

function SearchResultsPane({
  stateInfo,
  results,
  query,
  searchStatus,
  isLoading,
  onSelect
}: {
  stateInfo: AppStateInfo | null
  results: SearchResult[]
  query: string
  searchStatus: SearchStatus | null
  isLoading: boolean
  onSelect(result: SearchResult): void
}) {
  if (isLoading && results.length === 0) {
    return (
      <EmptyState
        title="Searching"
        detail="Updating results…"
      />
    )
  }

  if (results.length === 0) {
    if (searchStatus?.state === "error") {
      return (
        <EmptyState
          title="Search unavailable"
          detail={searchStatus.message ?? "Semantic search is unavailable right now."}
        />
      )
    }

    if (query.trim()) {
      return (
        <EmptyState
          title="No matching threads"
          detail="No conversations matched the current search query and filters."
        />
      )
    }

    return (
      <EmptyState
        title="Search conversations"
        detail="Start typing to search all indexed Codex and Claude threads."
      />
    )
  }

  return (
    <div className="search-results-list" role="list">
      {searchStatus?.state === "warming" && query.trim().length >= 3 ? (
        <div className="search-status-banner">
          {searchStatus.message ?? "Search is still preparing semantic results."}
        </div>
      ) : null}
      {searchStatus?.state === "error" ? (
        <div className="search-status-banner">{searchStatus.message ?? "Search unavailable."}</div>
      ) : null}

      {results.map(result => (
        <button
          className="search-result-row"
          key={`${result.id}:${result.updatedAt}`}
          onClick={() => onSelect(result)}
          type="button"
        >
          <div className="search-result-header">
            <div className="session-title-group">
              {result.archived ? (
                <span className="archived-indicator" title="Archived">
                  A
                </span>
              ) : null}
              <span className="session-title">{result.threadName}</span>
            </div>
            <div className="session-row-meta">
              <ProviderIcon provider={result.provider} stateInfo={stateInfo} />
              <span className="session-time">{formatRelativeTimestamp(result.updatedAt)}</span>
            </div>
          </div>
          <span className="search-result-snippet">{result.snippet}</span>
        </button>
      ))}
    </div>
  )
}

function SettingsValue({
  value,
  monospace = false
}: {
  value: ReactNode
  monospace?: boolean
}) {
  if (value === null || value === undefined || value === "") {
    return <span className="settings-meta-value settings-meta-muted">Unavailable</span>
  }

  return (
    <span className={`settings-meta-value ${monospace ? "is-monospace" : ""}`}>
      {value}
    </span>
  )
}

function ProviderSettingsCard({
  title,
  description,
  info,
  overrides,
  onOverrideChange,
  onReset
}: {
  title: string
  description: string
  info: ProviderSettingsInfo
  overrides: ProviderLaunchOverrides
  onOverrideChange(patch: Partial<ProviderLaunchOverrides>): void
  onReset(): void
}) {
  const isCodex = info.provider === "codex"

  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-copy">
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <button className="ghost-button settings-reset-button" onClick={onReset} type="button">
          Reset overrides
        </button>
      </div>

      <div className="settings-field-list">
        <label className="settings-field">
          <span className="settings-field-label">
            {isCodex ? "Codex binary path" : "Claude binary path"}
          </span>
          <input
            className="settings-input"
            onChange={event => onOverrideChange({ binaryPath: event.target.value })}
            placeholder={isCodex ? "codex" : "claude"}
            type="text"
            value={overrides.binaryPath}
          />
          <span className="settings-field-help">
            Leave blank to use {isCodex ? "`codex`" : "`claude`"} from your PATH.
          </span>
        </label>

        <label className="settings-field">
          <span className="settings-field-label">
            {isCodex ? "CODEX_HOME path" : "Claude home path"}
          </span>
          <input
            className="settings-input"
            onChange={event => onOverrideChange({ homePath: event.target.value })}
            placeholder={isCodex ? "~/.codex" : "~/.claude"}
            type="text"
            value={overrides.homePath}
          />
          <span className="settings-field-help">
            Leave blank to use the default {isCodex ? "Codex" : "Claude"} home path.
          </span>
        </label>
      </div>

      <div className="settings-meta-grid">
        <div className="settings-meta-item">
          <span className="settings-meta-label">
            {isCodex ? "Current model" : "Observed model"}
          </span>
          <SettingsValue value={isCodex ? info.model : info.observedModel} />
        </div>
        <div className="settings-meta-item">
          <span className="settings-meta-label">
            {isCodex ? "Reasoning effort" : "Effort level"}
          </span>
          <SettingsValue value={isCodex ? info.reasoningEffort : info.effortLevel} />
        </div>
        <div className="settings-meta-item">
          <span className="settings-meta-label">
            {isCodex ? "Service tier" : "Always thinking"}
          </span>
          <SettingsValue
            value={
              isCodex
                ? info.serviceTier
                : info.alwaysThinkingEnabled === null
                  ? null
                  : info.alwaysThinkingEnabled
                    ? "Enabled"
                    : "Disabled"
            }
          />
        </div>
        <div className="settings-meta-item settings-meta-item-wide">
          <span className="settings-meta-label">Config path</span>
          <SettingsValue monospace value={info.configPath} />
        </div>
        <div className="settings-meta-item settings-meta-item-wide">
          <span className="settings-meta-label">Binary source</span>
          <SettingsValue
            monospace
            value={
              info.binarySource === "override"
                ? `Override · ${info.effectiveBinaryPath}`
                : `PATH · ${info.effectiveBinaryPath}`
            }
          />
        </div>
        <div className="settings-meta-item settings-meta-item-wide">
          <span className="settings-meta-label">Home source</span>
          <SettingsValue
            monospace
            value={
              info.homeSource === "override"
                ? `Override · ${info.effectiveHomePath}`
                : `Default · ${info.effectiveHomePath}`
            }
          />
        </div>
      </div>
    </section>
  )
}

function TerminalSettingsCard({
  terminalOptions,
  enabledTerminalIds,
  defaultTerminalId,
  onToggle,
  onSelectDefault
}: {
  terminalOptions: TerminalOption[]
  enabledTerminalIds: TerminalAppId[]
  defaultTerminalId: TerminalAppId
  onToggle(terminalId: TerminalAppId): void
  onSelectDefault(terminalId: TerminalAppId): void
}) {
  return (
    <section className="settings-card">
      <div className="settings-card-copy">
        <h2>Terminals</h2>
        <p>
          Select which terminals Handoff may use. The default terminal is used for
          project opens and CLI session resumes.
        </p>
      </div>

      <div className="terminal-settings-list">
        {terminalOptions.map(option => {
          const isEnabled = enabledTerminalIds.includes(option.id)
          const isDefault = defaultTerminalId === option.id
          const isLastEnabled = enabledTerminalIds.length === 1 && isEnabled

          return (
            <div className="terminal-settings-row" key={option.id}>
              <label className="terminal-settings-toggle">
                <input
                  checked={isEnabled}
                  disabled={isLastEnabled}
                  onChange={() => onToggle(option.id)}
                  type="checkbox"
                />
                <span className="terminal-settings-copy">
                  <span className="terminal-settings-name">{option.label}</span>
                  <span
                    className={`terminal-settings-status ${
                      option.installed ? "is-installed" : "is-unavailable"
                    }`}
                  >
                    {option.installed ? "Installed" : "Unavailable"}
                  </span>
                </span>
              </label>

              <button
                className={`terminal-default-button ${isDefault ? "is-default" : ""}`}
                disabled={!isEnabled}
                onClick={() => onSelectDefault(option.id)}
                type="button"
              >
                {isDefault ? "Default" : "Make default"}
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function BridgeSettingsCard({
  bridgeStatus,
  bridgeSnippets,
  bridgeError,
  onCopySnippet
}: {
  bridgeStatus: AgentBridgeHealth | null
  bridgeSnippets: AgentBridgeConfigSnippets | null
  bridgeError: string | null
  onCopySnippet(label: string, value: string): void
}) {
  if (bridgeError) {
    return (
      <section className="settings-card">
        <div className="settings-card-copy">
          <h2>Agent bridge</h2>
          <p>{bridgeError}</p>
        </div>
      </section>
    )
  }

  if (!bridgeStatus || !bridgeSnippets) {
    return (
      <section className="settings-card">
        <div className="settings-card-copy">
          <h2>Agent bridge</h2>
          <p>Loading MCP bridge status and configuration snippets.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="settings-card">
      <div className="settings-card-copy">
        <h2>Agent bridge</h2>
        <p>
          Exposes saved Handoff agents through a local MCP stdio entrypoint. Async jobs are
          started quickly, then clients poll for completion while Handoff runs the provider
          headlessly in the background.
        </p>
      </div>

      <div className="settings-meta-grid">
        <div className="settings-meta-item">
          <span className="settings-meta-label">Status</span>
          <SettingsValue value={bridgeStatus.status === "ready" ? "Ready" : "Error"} />
        </div>
        <div className="settings-meta-item settings-meta-item-wide">
          <span className="settings-meta-label">Command</span>
          <SettingsValue
            monospace
            value={[bridgeStatus.command, ...bridgeStatus.args].join(" ")}
          />
        </div>
        <div className="settings-meta-item settings-meta-item-wide">
          <span className="settings-meta-label">Runs log</span>
          <SettingsValue monospace value={bridgeStatus.runsLogPath} />
        </div>
        <div className="settings-meta-item settings-meta-item-wide">
          <span className="settings-meta-label">State directory</span>
          <SettingsValue monospace value={bridgeStatus.stateDir} />
        </div>
      </div>

      <div className="settings-field-list">
        <div className="settings-field">
          <span className="settings-field-label">Codex MCP command</span>
          <textarea
            className="settings-input settings-code-block"
            readOnly
            spellCheck={false}
            value={bridgeSnippets.codexCommand}
          />
          <div className="settings-card-inline-actions">
            <button
              className="ghost-button"
              onClick={() => onCopySnippet("Codex MCP command", bridgeSnippets.codexCommand)}
              type="button"
            >
              Copy
            </button>
          </div>
        </div>

        <div className="settings-field">
          <span className="settings-field-label">Claude MCP config</span>
          <textarea
            className="settings-input settings-code-block"
            readOnly
            spellCheck={false}
            value={bridgeSnippets.claudeConfigJson}
          />
          <div className="settings-card-inline-actions">
            <button
              className="ghost-button"
              onClick={() =>
                onCopySnippet("Claude MCP config", bridgeSnippets.claudeConfigJson)
              }
              type="button"
            >
              Copy
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function SettingsPane({
  settingsSnapshot,
  settingsError,
  bridgeStatus,
  bridgeSnippets,
  bridgeError,
  onCopyBridgeSnippet,
  onProviderOverrideChange,
  onProviderReset,
  onTerminalToggle,
  onDefaultTerminalSelect
}: {
  settingsSnapshot: HandoffSettingsSnapshot | null
  settingsError: string | null
  bridgeStatus: AgentBridgeHealth | null
  bridgeSnippets: AgentBridgeConfigSnippets | null
  bridgeError: string | null
  onCopyBridgeSnippet(label: string, value: string): void
  onProviderOverrideChange(
    provider: SessionProvider,
    patch: Partial<ProviderLaunchOverrides>
  ): void
  onProviderReset(provider: SessionProvider): void
  onTerminalToggle(terminalId: TerminalAppId): void
  onDefaultTerminalSelect(terminalId: TerminalAppId): void
}) {
  if (settingsError) {
    return (
      <EmptyState
        title="Unable to load settings"
        detail={settingsError}
      />
    )
  }

  if (!settingsSnapshot) {
    return (
      <EmptyState
        title="Loading settings"
        detail="Reading Handoff settings and provider configuration info."
      />
    )
  }

  return (
    <div className="settings-layout">
      <ProviderSettingsCard
        description="These overrides apply to terminal-based Codex launches from Handoff."
        info={settingsSnapshot.providerInfo.codex}
        onOverrideChange={patch => onProviderOverrideChange("codex", patch)}
        onReset={() => onProviderReset("codex")}
        overrides={settingsSnapshot.settings.providers.codex}
        title="Codex model info"
      />

      <ProviderSettingsCard
        description="These overrides apply to terminal-based Claude launches from Handoff."
        info={settingsSnapshot.providerInfo.claude}
        onOverrideChange={patch => onProviderOverrideChange("claude", patch)}
        onReset={() => onProviderReset("claude")}
        overrides={settingsSnapshot.settings.providers.claude}
        title="Claude model info"
      />

      <TerminalSettingsCard
        defaultTerminalId={settingsSnapshot.settings.terminals.defaultTerminalId}
        enabledTerminalIds={settingsSnapshot.settings.terminals.enabledTerminalIds}
        onSelectDefault={onDefaultTerminalSelect}
        onToggle={onTerminalToggle}
        terminalOptions={settingsSnapshot.terminalOptions}
      />

      <BridgeSettingsCard
        bridgeError={bridgeError}
        bridgeSnippets={bridgeSnippets}
        bridgeStatus={bridgeStatus}
        onCopySnippet={onCopyBridgeSnippet}
      />
    </div>
  )
}

function AgentsListPane({
  agents,
  agentsError,
  isDashboardSelected,
  isLoading,
  onCreate,
  onSelectDashboard,
  onSelect,
  selectedAgentId,
  stateInfo
}: {
  agents: AgentDefinition[]
  agentsError: string | null
  isDashboardSelected: boolean
  isLoading: boolean
  onCreate(): void
  onSelectDashboard(): void
  onSelect(agentId: string): void
  selectedAgentId: string | null
  stateInfo: AppStateInfo | null
}) {
  if (agentsError) {
    return (
      <div className="agent-list">
        <EmptyState
          title="Unable to load agents"
          detail={agentsError}
        />
      </div>
    )
  }

  return (
    <div className="agent-list" role="list">
      <div className="agent-list-create-row">
        <button
          className="sidebar-filter-button sidebar-filter-list-button"
          onClick={onCreate}
          type="button"
        >
          <WriteIcon />
          <span className="sidebar-filter-button-label">New agent</span>
        </button>
      </div>

      <button
        className={`session-row ${isDashboardSelected ? "is-active" : ""}`}
        onClick={onSelectDashboard}
        type="button"
      >
        <div className="session-row-main">
          <div className="session-title-group agent-list-dashboard-title">
            <DashboardIcon />
            <span className="session-title">Dashboard</span>
          </div>
        </div>
      </button>

      {isLoading ? (
        <EmptyState
          title="Loading agents"
          detail="Reading saved agent presets."
        />
      ) : agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          detail="Create an agent to save provider, model, and instruction presets."
        />
      ) : (
        sortAgentsByName(agents).map(agent => (
          <button
            className={`session-row ${
              !isDashboardSelected && agent.id === selectedAgentId ? "is-active" : ""
            }`}
            key={agent.id}
            onClick={() => onSelect(agent.id)}
            title={getComposerModelLabel(agent.provider, agent.modelId)}
            type="button"
          >
            <div className="session-row-main">
              <div className="session-title-group">
                <span className="session-title">{agent.name}</span>
              </div>
              <div className="session-row-meta">
                <ProviderIcon provider={agent.provider} stateInfo={stateInfo} />
              </div>
            </div>
          </button>
        ))
      )}
    </div>
  )
}

function AgentSummaryPane({
  agent,
  onDelete,
  onDuplicate,
  onEdit
}: {
  agent: AgentDefinition | null
  onDelete(): void
  onDuplicate(): void
  onEdit(): void
}) {
  if (!agent) {
    return (
      <EmptyState
        title="No agent selected"
        detail="Pick an agent from the left list."
      />
    )
  }

  const thinkingLabel =
    THINKING_LEVEL_OPTIONS.find(option => option.value === agent.thinkingLevel)?.label ??
    agent.thinkingLevel

  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-copy">
          <h2>{agent.name}</h2>
        </div>
        <div className="agent-editor-header-actions">
          <button className="ghost-button" onClick={onEdit} type="button">
            Edit
          </button>
          <button className="ghost-button" onClick={onDuplicate} type="button">
            Duplicate
          </button>
          <button className="ghost-button" onClick={onDelete} type="button">
            Delete
          </button>
        </div>
      </div>

      <div className="agent-summary-row">
        <span className="agent-summary-pill">{formatProviderLabel(agent.provider)}</span>
        <span className="agent-summary-pill">
          {getComposerModelLabel(agent.provider, agent.modelId)}
        </span>
        <span className="agent-summary-pill">{thinkingLabel}</span>
        <span className="agent-summary-pill">{agent.fast ? "Fast" : "Standard"}</span>
        <span className="agent-summary-pill">
          {agent.timeoutSec === null ? "No timeout" : `${agent.timeoutSec}s timeout`}
        </span>
        {agent.specialty?.trim() ? (
          <span className="agent-summary-pill">{agent.specialty.trim()}</span>
        ) : null}
      </div>
    </section>
  )
}

function AgentEditorPane({
  agent,
  draft,
  editorError,
  onCancel,
  onDraftChange,
  onReset,
  onSave
}: {
  agent: AgentDefinition | null
  draft: AgentDefinition | null
  editorError: string | null
  onCancel(): void
  onDraftChange(patch: AgentUpdatePatch): void
  onReset(): void
  onSave(): void
}) {
  if (!agent) {
    return (
      <EmptyState
        title="No agent selected"
        detail="Pick an agent from the left list or create a new one."
      />
    )
  }

  if (!draft) {
    return (
      <EmptyState
        title="Loading agent"
        detail="Preparing the selected agent."
      />
    )
  }

  const isDirty = !areAgentsEqual(agent, draft)
  const modelOptions = getComposerModelOptions(draft.provider)
  const supportsFastMode = getComposerProviderConfig(draft.provider).supportsFastMode

  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-copy">
          <h2>Edit agent</h2>
        </div>
      </div>

      <div className="settings-field-list">
        <label className="settings-field">
          <span className="settings-field-label">Name</span>
          <input
            className="settings-input"
            onChange={event => onDraftChange({ name: event.target.value })}
            type="text"
            value={draft.name}
          />
        </label>

        <label className="settings-field">
          <span className="settings-field-label">Specialty</span>
          <input
            className="settings-input"
            onChange={event => onDraftChange({ specialty: event.target.value })}
            placeholder="When should Handoff use this agent?"
            type="text"
            value={draft.specialty ?? ""}
          />
        </label>

        <div className="agent-editor-grid">
          <label className="settings-field">
            <span className="settings-field-label">Provider</span>
            <select
              className="settings-input"
              onChange={event =>
                onDraftChange({ provider: event.target.value as SessionProvider })
              }
              value={draft.provider}
            >
              {NEW_THREAD_VENDOR_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span className="settings-field-label">Model</span>
            <select
              className="settings-input"
              onChange={event => onDraftChange({ modelId: event.target.value })}
              value={draft.modelId}
            >
              {modelOptions.map(option => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span className="settings-field-label">Thinking strength</span>
            <select
              className="settings-input"
              onChange={event =>
                onDraftChange({ thinkingLevel: event.target.value as ThinkingLevel })
              }
              value={draft.thinkingLevel}
            >
              {THINKING_LEVEL_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="new-thread-inline-toggle">
          <input
            checked={draft.fast}
            disabled={!supportsFastMode}
            onChange={event => onDraftChange({ fast: event.target.checked })}
            type="checkbox"
          />
          <span>{supportsFastMode ? "Fast mode" : "Fast mode unavailable for this provider"}</span>
        </label>

        <label className="settings-field">
          <span className="settings-field-label">Timeout (seconds)</span>
          <input
            className="settings-input"
            inputMode="numeric"
            min={1}
            max={1800}
            onChange={event => {
              const value = event.target.value.trim()
              const nextTimeoutSec = value ? Number(value) : null
              onDraftChange({
                timeoutSec: Number.isFinite(nextTimeoutSec) ? nextTimeoutSec : null
              })
            }}
            placeholder="None"
            type="number"
            value={draft.timeoutSec ?? ""}
          />
        </label>

        <label className="settings-field">
          <span className="settings-field-label">Custom instructions</span>
          <textarea
            className="new-thread-prompt-input agent-editor-textarea"
            onChange={event =>
              onDraftChange({ customInstructions: event.target.value })
            }
            placeholder="Add custom instructions"
            spellCheck={false}
            value={draft.customInstructions}
          />
        </label>
      </div>

      {editorError ? <div className="new-thread-inline-error">{editorError}</div> : null}

      <div className="new-thread-actions">
        <button className="ghost-button" onClick={onCancel} type="button">
          Cancel
        </button>
        <button className="ghost-button" disabled={!isDirty} onClick={onReset} type="button">
          Reset
        </button>
        <button className="accent-button" onClick={onSave} type="button">
          Save
        </button>
      </div>
    </section>
  )
}

function AgentRunsPane({
  emptyText,
  isLoading,
  onCancelRun,
  onToggleRun,
  runs,
  runsError,
  showAgentName,
  title
}: {
  emptyText: string
  isLoading: boolean
  onCancelRun(runId: string): void
  onToggleRun(runId: string): void
  runs: AgentRunRecord[]
  runsError: string | null
  showAgentName: boolean
  title: string
}) {
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set())
  const [relativeNow, setRelativeNow] = useState(() => Date.now())

  useEffect(() => {
    setExpandedRunIds(current => {
      const next = new Set<string>()

      for (const run of runs) {
        if (current.has(run.runId)) {
          next.add(run.runId)
        }
      }

      return next
    })
  }, [runs])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setRelativeNow(Date.now())
    }, 60_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  const toggleRun = useCallback(
    (runId: string) => {
      setExpandedRunIds(current => {
        const next = new Set(current)
        if (next.has(runId)) {
          next.delete(runId)
        } else {
          next.add(runId)
        }

        return next
      })
      onToggleRun(runId)
    },
    [onToggleRun]
  )

  return (
    <section className="settings-card">
      <div className="settings-card-copy">
        <h2>{title}</h2>
      </div>

      {runsError ? <div className="new-thread-inline-error">{runsError}</div> : null}

      {isLoading && runs.length === 0 ? (
        <p className="agent-run-empty">Loading run history.</p>
      ) : runs.length === 0 ? (
        <p className="agent-run-empty">{emptyText}</p>
      ) : (
        <div className="agent-run-stack" role="list">
          {runs.map(run => {
            const isExpanded = expandedRunIds.has(run.runId)
            const hasResult =
              run.status === "completed" ? Boolean(run.answer) : Boolean(run.error)
            const relativeAge = formatAgentRunAge(run.startedAt, relativeNow)

            return (
              <article className="agent-run-card" key={run.runId}>
                <button
                  aria-expanded={isExpanded}
                  className="agent-run-summary"
                  onClick={() => toggleRun(run.runId)}
                  type="button"
                >
                  <div className="agent-run-summary-main">
                    <div className="agent-run-summary-title-row">
                      <span className="agent-run-title">
                        {showAgentName ? run.agentName : getAgentRunHistoryLabel(run)}
                      </span>
                      <span className="agent-run-project-pill">
                        {getAgentRunProjectLabel(run.projectPath)}
                      </span>
                      {relativeAge ? (
                        <span className="agent-run-age-pill">{relativeAge}</span>
                      ) : null}
                    </div>
                    <div className="agent-run-summary-subtitle">
                      {showAgentName ? getAgentRunThreadLabel(run) : run.runId}
                    </div>
                  </div>
                  <span
                    aria-label={formatAgentRunStatus(run.status)}
                    className={`agent-run-status-dot is-${run.status}`}
                  />
                </button>

                {isExpanded ? (
                  <div className="agent-run-expanded">
                    <div className="agent-run-expanded-meta">
                      <span>Started {formatTimestamp(run.startedAt)}</span>
                      {run.finishedAt ? (
                        <span>Finished {formatTimestamp(run.finishedAt)}</span>
                      ) : null}
                    </div>

                    <div className="agent-run-expanded-body">
                      <div className="agent-run-expanded-section">
                        <span className="settings-field-label">Request</span>
                        <div className="conversation-entry user-entry agent-run-message">
                          <div className="user-bubble">
                            <MarkdownBlock
                              className="message-markdown agent-run-text-block"
                              markdown={run.message}
                            />
                          </div>
                        </div>
                      </div>

                      {hasResult ? (
                        <div className="agent-run-expanded-section">
                          <span className="settings-field-label">
                            {getAgentRunResultLabel(run)}
                          </span>
                          <div className="conversation-entry assistant-entry agent-run-message">
                            <MarkdownBlock
                              className="message-markdown assistant-markdown agent-run-text-block"
                              markdown={run.status === "completed" ? run.answer ?? "" : run.error ?? ""}
                            />
                          </div>
                        </div>
                      ) : null}

                      {run.status === "running" ? (
                        <div className="settings-card-inline-actions">
                          <button
                            className="ghost-button"
                            onClick={() => onCancelRun(run.runId)}
                            type="button"
                          >
                            Cancel run
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function AgentAutomationPane({
  skillsStatus,
  skillsError,
  skillTimeouts,
  isBusy,
  onInstall,
  onExportPackage,
  onCopySetupInstructions,
  onToolTimeoutChange
}: {
  skillsStatus: HandoffSkillsStatus | null
  skillsError: string | null
  skillTimeouts: Record<SessionProvider, number | null>
  isBusy: boolean
  onInstall(target: SkillInstallTarget): void
  onExportPackage(): void
  onCopySetupInstructions(target: SkillInstallTarget): void
  onToolTimeoutChange(provider: SessionProvider, timeoutSec: number | null): void
}) {
  return (
    <section className="settings-card">
      <div className="settings-card-copy">
        <h2>Automation / Skills</h2>
        <p>
          Install the generic Handoff bridge skill for Codex and Claude Code. The
          installed skill routes by exact agent name first, then specialty.
        </p>
      </div>

      <div className="settings-field-list">
        <label className="settings-field">
          <span className="settings-field-label">Codex client MCP timeout (seconds)</span>
          <input
            className="settings-input"
            inputMode="numeric"
            min={1}
            onChange={event => {
              const value = event.target.value.trim()
              const nextTimeoutSec = value ? Number(value) : null
              onToolTimeoutChange(
                "codex",
                Number.isFinite(nextTimeoutSec) && nextTimeoutSec !== null && nextTimeoutSec > 0
                  ? nextTimeoutSec
                  : null
              )
            }}
            placeholder="Provider default"
            type="number"
            value={skillTimeouts.codex ?? ""}
          />
          <span className="settings-field-help">
            Blank uses Codex&apos;s default MCP tool-call timeout. Async bridge jobs reduce
            the need for long values. Changes apply on the next install or reinstall.
          </span>
        </label>

        <label className="settings-field">
          <span className="settings-field-label">Claude client MCP timeout (seconds)</span>
          <input
            className="settings-input"
            inputMode="numeric"
            min={1}
            onChange={event => {
              const value = event.target.value.trim()
              const nextTimeoutSec = value ? Number(value) : null
              onToolTimeoutChange(
                "claude",
                Number.isFinite(nextTimeoutSec) && nextTimeoutSec !== null && nextTimeoutSec > 0
                  ? nextTimeoutSec
                  : null
              )
            }}
            placeholder="Provider default"
            type="number"
            value={skillTimeouts.claude ?? ""}
          />
          <span className="settings-field-help">
            Blank uses Claude Code&apos;s default MCP tool-call timeout. Async bridge jobs
            reduce the need for long values. Changes apply on the next install or reinstall.
          </span>
        </label>
      </div>

      {skillsError ? <div className="new-thread-inline-error">{skillsError}</div> : null}

      {!skillsStatus ? (
        <p className="agent-run-empty">Loading install status.</p>
      ) : (
        <div className="automation-provider-list">
          {(["codex", "claude"] as const).map(provider => {
            const providerStatus = skillsStatus.providers[provider]

            return (
              <div className="automation-provider-row" key={provider}>
                <div className="automation-provider-header">
                  <span className="automation-provider-name">
                    {formatProviderLabel(provider)}
                  </span>
                  <span
                    className={`automation-provider-state is-${
                      providerStatus.skillInstalled && providerStatus.mcpInstalled
                        ? "ready"
                        : providerStatus.skillInstalled || providerStatus.mcpInstalled
                          ? "partial"
                          : "idle"
                    }`}
                  >
                    {formatSkillInstallState(providerStatus)}
                  </span>
                </div>
                <div className="settings-meta-grid">
                  <div className="settings-meta-item">
                    <span className="settings-meta-label">MCP</span>
                    <SettingsValue value={providerStatus.mcpInstalled ? "Installed" : "Missing"} />
                  </div>
                  <div className="settings-meta-item">
                    <span className="settings-meta-label">Skill</span>
                    <SettingsValue
                      value={providerStatus.skillInstalled ? "Installed" : "Missing"}
                    />
                  </div>
                  <div className="settings-meta-item settings-meta-item-wide">
                    <span className="settings-meta-label">Config path</span>
                    <SettingsValue monospace value={providerStatus.configPath} />
                  </div>
                  <div className="settings-meta-item settings-meta-item-wide">
                    <span className="settings-meta-label">Skill path</span>
                    <SettingsValue monospace value={providerStatus.skillPath} />
                  </div>
                </div>
                {providerStatus.error ? (
                  <div className="new-thread-inline-error">{providerStatus.error}</div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <div className="automation-actions">
        <button
          className="ghost-button"
          disabled={isBusy}
          onClick={() => onInstall("codex")}
          type="button"
        >
          Install in Codex
        </button>
        <button
          className="ghost-button"
          disabled={isBusy}
          onClick={() => onInstall("claude")}
          type="button"
        >
          Install in Claude
        </button>
        <button
          className="ghost-button"
          disabled={isBusy}
          onClick={() => onInstall("both")}
          type="button"
        >
          Install both
        </button>
        <button
          className="ghost-button"
          disabled={isBusy}
          onClick={() => onInstall("both")}
          type="button"
        >
          Update/Reinstall
        </button>
        <button
          className="ghost-button"
          disabled={isBusy}
          onClick={onExportPackage}
          type="button"
        >
          Export package
        </button>
        <button
          className="ghost-button"
          disabled={isBusy}
          onClick={() => onCopySetupInstructions("both")}
          type="button"
        >
          Copy setup instructions
        </button>
      </div>
    </section>
  )
}

function AgentDashboardPane({
  bridgeStatus,
  isLoadingRuns,
  onCancelRun,
  onOpenAutomation,
  onToggleRun,
  runs,
  runsError,
  skillsError,
  skillsStatus
}: {
  bridgeStatus: AgentBridgeHealth | null
  isLoadingRuns: boolean
  onCancelRun(runId: string): void
  onOpenAutomation(): void
  onToggleRun(runId: string): void
  runs: AgentRunRecord[]
  runsError: string | null
  skillsError: string | null
  skillsStatus: HandoffSkillsStatus | null
}) {
  return (
    <div className="settings-layout">
      <button className="agent-dashboard-toolbar" onClick={onOpenAutomation} type="button">
        <span className="agent-dashboard-toolbar-title">Automation / Skills</span>
        <span className="agent-dashboard-toolbar-summary">
          <span className="automation-status-chip">
            <StatusMarkerIcon state={getAutomationStatusTone({ bridgeStatus })} />
            <span>Bridge</span>
          </span>
          <span className="automation-status-chip">
            <StatusMarkerIcon
              state={getAutomationStatusTone({
                providerStatus: skillsStatus?.providers.codex
              })}
            />
            <span>Codex</span>
          </span>
          <span className="automation-status-chip">
            <StatusMarkerIcon
              state={getAutomationStatusTone({
                providerStatus: skillsStatus?.providers.claude
              })}
            />
            <span>Claude</span>
          </span>
        </span>
      </button>

      {skillsError ? <div className="new-thread-inline-error">{skillsError}</div> : null}

      <AgentRunsPane
        emptyText="No agent invocations recorded yet."
        isLoading={isLoadingRuns}
        onCancelRun={onCancelRun}
        onToggleRun={onToggleRun}
        runs={runs}
        runsError={runsError}
        showAgentName
        title="Recent invocations"
      />
    </div>
  )
}

function AgentDetailPane({
  agent,
  draft,
  editorError,
  isEditing,
  isLoadingRuns,
  onCancelEdit,
  onCancelRun,
  onDelete,
  onDraftChange,
  onDuplicate,
  onEdit,
  onReset,
  onSave,
  onToggleRun,
  runs,
  runsError
}: {
  agent: AgentDefinition | null
  draft: AgentDefinition | null
  editorError: string | null
  isEditing: boolean
  isLoadingRuns: boolean
  onCancelEdit(): void
  onCancelRun(runId: string): void
  onDelete(): void
  onDraftChange(patch: AgentUpdatePatch): void
  onDuplicate(): void
  onEdit(): void
  onReset(): void
  onSave(): void
  onToggleRun(runId: string): void
  runs: AgentRunRecord[]
  runsError: string | null
}) {
  return (
    <div className="settings-layout">
      {isEditing ? (
        <AgentEditorPane
          agent={agent}
          draft={draft}
          editorError={editorError}
          onCancel={onCancelEdit}
          onDraftChange={onDraftChange}
          onReset={onReset}
          onSave={onSave}
        />
      ) : (
        <AgentSummaryPane
          agent={agent}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onEdit={onEdit}
        />
      )}

      <AgentRunsPane
        emptyText="No bridge runs recorded for this agent yet."
        isLoading={isLoadingRuns}
        onCancelRun={onCancelRun}
        onToggleRun={onToggleRun}
        runs={runs}
        runsError={runsError}
        showAgentName={false}
        title="Agent tasks"
      />
    </div>
  )
}

function NewThreadPane({
  draft,
  generatedPrompt,
  isLoadingSourceTranscript,
  onCopyPrompt,
  onDraftChange,
  onProjectPathChange,
  onSelectSourceSession,
  onSourceQueryChange,
  onStartThread,
  promptError,
  projectOptions,
  projectPath,
  sourceError,
  sourceQuery,
  sourceResults,
  selectedSourceSession,
  stateInfo
}: {
  draft: NewThreadDraft
  generatedPrompt: string
  isLoadingSourceTranscript: boolean
  onCopyPrompt(): void
  onDraftChange(patch: Partial<NewThreadDraft>): void
  onProjectPathChange(projectPath: string | null): void
  onSelectSourceSession(session: SessionListItem | null): void
  onSourceQueryChange(value: string): void
  onStartThread(): void
  promptError: string | null
  projectOptions: ProjectFilterOption[]
  projectPath: string | null
  sourceError: string | null
  sourceQuery: string
  sourceResults: SessionListItem[]
  selectedSourceSession: SessionListItem | null
  stateInfo: AppStateInfo | null
}) {
  const [isSourceMenuOpen, setIsSourceMenuOpen] = useState(false)
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false)
  const [openTargetMenuKey, setOpenTargetMenuKey] =
    useState<NewThreadTargetMenuKey | null>(null)
  const [projectQuery, setProjectQuery] = useState("")
  const sourceInputRef = useRef<HTMLInputElement | null>(null)
  const projectInputRef = useRef<HTMLInputElement | null>(null)
  const sourceMenuRef = useRef<HTMLDivElement | null>(null)
  const projectMenuRef = useRef<HTMLDivElement | null>(null)
  const targetMenuRef = useRef<HTMLDivElement | null>(null)

  const activeProviderConfig = getComposerProviderConfig(draft.vendor)
  const launchModeOptions = NEW_THREAD_LAUNCH_MODE_OPTIONS.filter(option =>
    isComposerLaunchModeSupported(draft.vendor, option.value)
  )
  const selectedModelLabel = getComposerModelLabel(draft.vendor, draft.modelId)
  const optionsSummary = formatComposerOptionsSummary(draft)
  const filteredProjectOptions = useMemo(() => {
    const normalizedQuery = projectQuery.trim().toLowerCase()

    return projectOptions
      .filter(option => {
        if (!normalizedQuery) {
          return true
        }

        return [option.label, option.path].join(" ").toLowerCase().includes(normalizedQuery)
      })
      .slice(0, 12)
  }, [projectOptions, projectQuery])

  useEffect(() => {
    if (!isSourceMenuOpen) {
      return
    }

    sourceInputRef.current?.focus()
  }, [isSourceMenuOpen])

  useEffect(() => {
    if (!isProjectMenuOpen) {
      return
    }

    projectInputRef.current?.focus()
  }, [isProjectMenuOpen])

  useEffect(() => {
    if (!isSourceMenuOpen) {
      return () => undefined
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && sourceMenuRef.current?.contains(target)) {
        return
      }

      setIsSourceMenuOpen(false)
      onSourceQueryChange("")
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsSourceMenuOpen(false)
        onSourceQueryChange("")
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isSourceMenuOpen, onSourceQueryChange])

  useEffect(() => {
    if (!isProjectMenuOpen) {
      return () => undefined
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && projectMenuRef.current?.contains(target)) {
        return
      }

      setIsProjectMenuOpen(false)
      setProjectQuery("")
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsProjectMenuOpen(false)
        setProjectQuery("")
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isProjectMenuOpen])

  useEffect(() => {
    if (!openTargetMenuKey) {
      return () => undefined
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && targetMenuRef.current?.contains(target)) {
        return
      }

      setOpenTargetMenuKey(null)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenTargetMenuKey(null)
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [openTargetMenuKey])

  const startButtonLabel = buildNewThreadStartLabel(draft)
  const promptUnavailable = !generatedPrompt.trim()
  const startDisabled =
    promptUnavailable ||
    !projectPath ||
    Boolean(sourceError) ||
    (Boolean(selectedSourceSession) && isLoadingSourceTranscript)
  const startDisabledReason = selectedSourceSession && isLoadingSourceTranscript
    ? "Loading source thread…"
    : promptUnavailable
      ? "Select a source thread or add custom instructions before starting."
    : !projectPath
      ? "Select a project before starting."
      : sourceError
        ? sourceError
        : null

  function renderTargetMenuPanel() {
    if (openTargetMenuKey === "vendor") {
      return (
        <div aria-label="Provider options" className="new-thread-target-panel" role="menu">
          {NEW_THREAD_VENDOR_OPTIONS.map(option => (
            <button
              aria-checked={draft.vendor === option.value}
              className={`new-thread-target-option ${
                draft.vendor === option.value ? "is-selected" : ""
              }`}
              key={option.value}
              onClick={() => {
                onDraftChange({
                  vendor: option.value
                })
                setOpenTargetMenuKey(null)
              }}
              role="menuitemradio"
              type="button"
            >
              <span className="new-thread-target-option-main">
                <ProviderIcon provider={option.value} stateInfo={stateInfo} />
                <span>{getComposerProviderConfig(option.value).label}</span>
              </span>
              {draft.vendor === option.value ? (
                <span aria-hidden="true" className="new-thread-target-check">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )
    }

    if (openTargetMenuKey === "launchMode") {
      return (
        <div aria-label="Launch options" className="new-thread-target-panel" role="menu">
          {launchModeOptions.map(option => (
            <button
              aria-checked={draft.launchMode === option.value}
              className={`new-thread-target-option ${
                draft.launchMode === option.value ? "is-selected" : ""
              }`}
              key={option.value}
              onClick={() => {
                onDraftChange({ launchMode: option.value })
                setOpenTargetMenuKey(null)
              }}
              role="menuitemradio"
              type="button"
            >
              <span>{option.label}</span>
              {draft.launchMode === option.value ? (
                <span aria-hidden="true" className="new-thread-target-check">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )
    }

    if (openTargetMenuKey === "model") {
      return (
        <div
          aria-label="Model options"
          className="new-thread-target-panel new-thread-target-model-panel"
          role="menu"
        >
          {getComposerModelOptions(draft.vendor).map(option => (
            <button
              aria-checked={draft.modelId === option.id}
              className={`new-thread-target-option ${
                draft.modelId === option.id ? "is-selected" : ""
              }`}
              key={option.id}
              onClick={() => {
                onDraftChange({ modelId: option.id })
                setOpenTargetMenuKey(null)
              }}
              role="menuitemradio"
              type="button"
            >
              <span>{option.label}</span>
              {draft.modelId === option.id ? (
                <span aria-hidden="true" className="new-thread-target-check">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )
    }

    if (openTargetMenuKey === "options") {
      return (
        <div
          aria-label="Thinking and fast mode options"
          className="new-thread-target-panel new-thread-target-options-panel"
          role="menu"
        >
          <div className="new-thread-target-group">
            <span className="new-thread-target-group-label">Reasoning</span>
            {THINKING_LEVEL_OPTIONS.map(option => (
              <button
                aria-checked={draft.thinkingLevel === option.value}
                className={`new-thread-target-option ${
                  draft.thinkingLevel === option.value ? "is-selected" : ""
                }`}
                key={option.value}
                onClick={() => {
                  onDraftChange({ thinkingLevel: option.value })
                  setOpenTargetMenuKey(null)
                }}
                role="menuitemradio"
                type="button"
              >
                <span>{option.label}</span>
                {draft.thinkingLevel === option.value ? (
                  <span aria-hidden="true" className="new-thread-target-check">
                    ✓
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {draft.vendor === "codex" ? (
            <div className="new-thread-target-group">
              <span className="new-thread-target-group-label">Fast Mode</span>
              {[
                { label: "Off", value: false },
                { label: "On", value: true }
              ].map(option => (
                <button
                  aria-checked={draft.fast === option.value}
                  className={`new-thread-target-option ${
                    draft.fast === option.value ? "is-selected" : ""
                  }`}
                  key={option.label}
                  onClick={() => {
                    onDraftChange({ fast: option.value })
                    setOpenTargetMenuKey(null)
                  }}
                  role="menuitemradio"
                  type="button"
                >
                  <span>{option.label}</span>
                  {draft.fast === option.value ? (
                    <span aria-hidden="true" className="new-thread-target-check">
                      ✓
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )
    }

    return null
  }

  return (
    <div className="new-thread-layout">
      <section className="settings-card new-thread-card">
        <div className="new-thread-source-project-row">
          <div className="new-thread-source-picker" ref={sourceMenuRef}>
            <button
              className={`settings-input new-thread-picker-trigger ${
                isSourceMenuOpen ? "is-open" : ""
              }`}
              onClick={() => {
                setIsProjectMenuOpen(false)
                setIsSourceMenuOpen(true)
              }}
              type="button"
            >
              <span
                className={`new-thread-picker-value ${
                  selectedSourceSession ? "" : "is-placeholder"
                }`}
              >
                {selectedSourceSession?.threadName ?? "Not starting from a previous thread"}
              </span>
              <ChevronDownIcon isOpen={isSourceMenuOpen} />
            </button>

            {isSourceMenuOpen ? (
              <div className="new-thread-source-menu" role="listbox">
                <input
                  className="settings-input new-thread-source-input"
                  onChange={event => onSourceQueryChange(event.target.value)}
                  placeholder="Search threads"
                  ref={sourceInputRef}
                  type="text"
                  value={sourceQuery}
                />

                <button
                  className={`new-thread-source-option ${
                    selectedSourceSession ? "" : "is-selected"
                  }`}
                  onClick={() => {
                    onSelectSourceSession(null)
                    setIsSourceMenuOpen(false)
                    onSourceQueryChange("")
                  }}
                  type="button"
                >
                  <span className="new-thread-source-option-title">
                    Not starting from a previous thread
                  </span>
                </button>

                {sourceResults.length === 0 ? (
                  <div className="new-thread-source-empty">No matching threads.</div>
                ) : (
                  sourceResults.map(session => (
                    <button
                      className={`new-thread-source-option ${
                        session.id === selectedSourceSession?.id ? "is-selected" : ""
                      }`}
                      key={session.id}
                      onClick={() => {
                        onSelectSourceSession(session)
                        setIsSourceMenuOpen(false)
                        onSourceQueryChange("")
                      }}
                      type="button"
                    >
                      <div className="new-thread-source-option-main">
                        <span className="new-thread-source-option-title">
                          {session.threadName}
                        </span>
                        <div className="new-thread-source-option-meta">
                          <ProviderIcon provider={session.provider} stateInfo={stateInfo} />
                          <span>{formatRelativeTimestamp(session.updatedAt)}</span>
                        </div>
                      </div>
                      <span
                        className="new-thread-source-option-subtitle"
                        title={session.projectPath ?? undefined}
                      >
                        {session.projectPath ?? "No project path"}
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div className="new-thread-source-picker" ref={projectMenuRef}>
            <button
              className={`settings-input new-thread-picker-trigger ${
                isProjectMenuOpen ? "is-open" : ""
              }`}
              onClick={() => {
                setIsSourceMenuOpen(false)
                onSourceQueryChange("")
                setIsProjectMenuOpen(true)
              }}
              type="button"
            >
              <span
                className={`new-thread-picker-value ${projectPath ? "" : "is-placeholder"}`}
                title={projectPath ?? undefined}
              >
                {projectPath ? formatProjectFilterLabel(projectPath) : "Select project"}
              </span>
              <ChevronDownIcon isOpen={isProjectMenuOpen} />
            </button>

            {isProjectMenuOpen ? (
              <div className="new-thread-source-menu" role="listbox">
                <input
                  className="settings-input new-thread-source-input"
                  onChange={event => setProjectQuery(event.target.value)}
                  placeholder="Search projects"
                  ref={projectInputRef}
                  type="text"
                  value={projectQuery}
                />

                {filteredProjectOptions.length === 0 ? (
                  <div className="new-thread-source-empty">No matching projects.</div>
                ) : (
                  filteredProjectOptions.map(option => (
                    <button
                      className={`new-thread-source-option ${
                        option.path === projectPath ? "is-selected" : ""
                      }`}
                      key={option.path}
                      onClick={() => {
                        onProjectPathChange(option.path)
                        setIsProjectMenuOpen(false)
                        setProjectQuery("")
                      }}
                      type="button"
                    >
                      <div className="new-thread-source-option-main">
                        <span className="new-thread-source-option-title">{option.label}</span>
                      </div>
                      <span className="new-thread-source-option-subtitle" title={option.path}>
                        {option.path}
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>

        {selectedSourceSession ? (
          <label className="new-thread-inline-toggle">
            <input
              checked={draft.includeDiffs}
              onChange={event => onDraftChange({ includeDiffs: event.target.checked })}
              type="checkbox"
            />
            <span>Include diffs</span>
          </label>
        ) : null}

        {isLoadingSourceTranscript ? (
          <div className="new-thread-inline-note">Loading source thread…</div>
        ) : null}
        {sourceError ? <div className="new-thread-inline-error">{sourceError}</div> : null}
      </section>

      <section className="settings-card new-thread-card">
        <div className="settings-card-copy">
          <h2>Target</h2>
          <p>
            Choose the provider, model, and launch behavior for the next thread.
          </p>
        </div>

        <div className="new-thread-target-picker" ref={targetMenuRef}>
          <div className="new-thread-target-row">
            <button
              aria-expanded={openTargetMenuKey === "vendor"}
              aria-haspopup="menu"
              className={`new-thread-target-trigger ${
                openTargetMenuKey === "vendor" ? "is-open" : ""
              }`}
              onClick={() =>
                setOpenTargetMenuKey(current => (current === "vendor" ? null : "vendor"))
              }
              type="button"
            >
              <ProviderIcon provider={draft.vendor} stateInfo={stateInfo} />
              <span>{activeProviderConfig.label}</span>
              <ChevronDownIcon isOpen={openTargetMenuKey === "vendor"} />
            </button>

            {draft.vendor === "codex" ? (
              <button
                aria-expanded={openTargetMenuKey === "launchMode"}
                aria-haspopup="menu"
                className={`new-thread-target-trigger ${
                  openTargetMenuKey === "launchMode" ? "is-open" : ""
                }`}
                onClick={() =>
                  setOpenTargetMenuKey(current =>
                    current === "launchMode" ? null : "launchMode"
                  )
                }
                type="button"
              >
                <span>{formatLaunchModeLabel(draft.launchMode)}</span>
                <ChevronDownIcon isOpen={openTargetMenuKey === "launchMode"} />
              </button>
            ) : null}

            <button
              aria-expanded={openTargetMenuKey === "model"}
              aria-haspopup="menu"
              className={`new-thread-target-trigger ${
                openTargetMenuKey === "model" ? "is-open" : ""
              }`}
              onClick={() =>
                setOpenTargetMenuKey(current => (current === "model" ? null : "model"))
              }
              type="button"
            >
              <span>{selectedModelLabel}</span>
              <ChevronDownIcon isOpen={openTargetMenuKey === "model"} />
            </button>

            <button
              aria-expanded={openTargetMenuKey === "options"}
              aria-haspopup="menu"
              className={`new-thread-target-trigger ${
                openTargetMenuKey === "options" ? "is-open" : ""
              }`}
              onClick={() =>
                setOpenTargetMenuKey(current => (current === "options" ? null : "options"))
              }
              type="button"
            >
              <span>{optionsSummary}</span>
              <ChevronDownIcon isOpen={openTargetMenuKey === "options"} />
            </button>
          </div>

          {renderTargetMenuPanel()}
        </div>

        <div className="new-thread-inline-note">
          {projectPath
            ? `Launch project: ${projectPath}`
            : "Launching a thread requires a source thread with a resolved project path."}
        </div>
      </section>

      <section className="settings-card new-thread-card">
        <div className="settings-card-copy">
          <h2>Custom instructions</h2>
          <p>Anything entered here is appended to the final prompt that Handoff copies or sends.</p>
        </div>

        <textarea
          className="new-thread-prompt-input"
          onChange={event => onDraftChange({ prompt: event.target.value })}
          placeholder="Add custom instructions"
          spellCheck={false}
          value={draft.prompt}
        />

        {promptError ? <div className="new-thread-inline-error">{promptError}</div> : null}
        {startDisabledReason ? (
          <div className="new-thread-inline-note">{startDisabledReason}</div>
        ) : null}

        <div className="new-thread-actions">
          <button
            className="ghost-button"
            disabled={promptUnavailable}
            onClick={onCopyPrompt}
            type="button"
          >
            Copy prompt
          </button>
          <button
            className="accent-button"
            disabled={startDisabled}
            onClick={onStartThread}
            type="button"
          >
            {startButtonLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

function getHandoffApi(): HandoffApi | null {
  return typeof window !== "undefined" ? window.handoffApp ?? null : null
}

export default function App() {
  const [activeSection, setActiveSection] = useState<AppSection>("threads")
  const [rightPaneMode, setRightPaneMode] = useState<"conversation" | "search" | "new-thread">(
    "conversation"
  )
  const [previousNonComposerPaneMode, setPreviousNonComposerPaneMode] = useState<"conversation" | "search">("conversation")
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [stateInfo, setStateInfo] = useState<AppStateInfo | null>(null)
  const [settingsSnapshot, setSettingsSnapshot] = useState<HandoffSettingsSnapshot | null>(
    null
  )
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [bridgeStatus, setBridgeStatus] = useState<AgentBridgeHealth | null>(null)
  const [bridgeSnippets, setBridgeSnippets] = useState<AgentBridgeConfigSnippets | null>(
    null
  )
  const [bridgeError, setBridgeError] = useState<string | null>(null)
  const [skillsStatus, setSkillsStatus] = useState<HandoffSkillsStatus | null>(null)
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [isMutatingSkills, setIsMutatingSkills] = useState(false)
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [isLoadingAgents, setIsLoadingAgents] = useState(true)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [agentsPaneView, setAgentsPaneView] = useState<AgentsPaneView>("dashboard")
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [isEditingAgent, setIsEditingAgent] = useState(false)
  const [agentDraft, setAgentDraft] = useState<AgentDefinition | null>(null)
  const [agentEditorError, setAgentEditorError] = useState<string | null>(null)
  const [agentRuns, setAgentRuns] = useState<AgentRunRecord[]>([])
  const [isLoadingAgentRuns, setIsLoadingAgentRuns] = useState(false)
  const [agentRunsError, setAgentRunsError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeTranscript, setActiveTranscript] =
    useState<ConversationTranscript | null>(null)
  const [isLoadingSessions, setIsLoadingSessions] = useState(true)
  const [isLoadingConversation, setIsLoadingConversation] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [toastState, setToastState] = useState<{
    id: number
    message: string
    tone: "success" | "error"
    visible: boolean
  } | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth
  )
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredSidebarWidth())
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() =>
    readStoredSidebarCollapsed()
  )
  const [sidebarFilters, setSidebarFilters] = useState<SearchFilters>(
    DEFAULT_SIDEBAR_FILTERS
  )
  const [threadOrganization, setThreadOrganization] = useState<ThreadOrganizationSettings>(
    () => createDefaultThreadOrganization()
  )
  const [searchFilters, setSearchFilters] = useState<SearchFilters>(
    DEFAULT_SEARCH_FILTERS
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchStatus, setSearchStatus] = useState<SearchStatus | null>(null)
  const [isSearchLoading, setIsSearchLoading] = useState(false)
  const [searchReturnActive, setSearchReturnActive] = useState(false)
  const [newThreadDraft, setNewThreadDraft] = useState<NewThreadDraft>(() =>
    createDefaultNewThreadDraft()
  )
  const [newThreadSourceQuery, setNewThreadSourceQuery] = useState("")
  const [newThreadSourceTranscript, setNewThreadSourceTranscript] =
    useState<ConversationTranscript | null>(null)
  const [newThreadSourceError, setNewThreadSourceError] = useState<string | null>(null)
  const [newThreadPromptError, setNewThreadPromptError] = useState<string | null>(null)
  const [isLoadingNewThreadSource, setIsLoadingNewThreadSource] = useState(false)
  const [hasTouchedNewThreadTarget, setHasTouchedNewThreadTarget] = useState(false)
  const [isFilterPopoverOpen, setIsFilterPopoverOpen] = useState(false)
  const [selectedOutputFormat, setSelectedOutputFormat] =
    useState<OutputFormatKey>("markdown")
  const [selectedCopyAction, setSelectedCopyAction] =
    useState<CopyActionKey>("chat-with-diffs")
  const [isOutputFormatMenuOpen, setIsOutputFormatMenuOpen] = useState(false)
  const [isCopyMenuOpen, setIsCopyMenuOpen] = useState(false)
  const [sidebarDragState, setSidebarDragState] = useState<{
    startX: number
    startWidth: number
  } | null>(null)
  const [threadDragItem, setThreadDragItem] = useState<ThreadDragItem | null>(null)
  const [threadDropIndicator, setThreadDropIndicator] = useState<ThreadDropIndicator | null>(
    null
  )
  const [isCreateCollectionDialogOpen, setIsCreateCollectionDialogOpen] = useState(false)
  const [newCollectionNameDraft, setNewCollectionNameDraft] = useState("New collection")
  const [editingCollectionAppearanceId, setEditingCollectionAppearanceId] = useState<string | null>(
    null
  )
  const [collectionAppearanceDraft, setCollectionAppearanceDraft] = useState<{
    icon: ThreadCollection["icon"]
    color: string
  }>({
    icon: DEFAULT_THREAD_COLLECTION_ICON,
    color: DEFAULT_THREAD_COLLECTION_COLOR
  })
  const [expandedThoughtChainIds, setExpandedThoughtChainIds] = useState<Set<string>>(
    () => new Set()
  )
  const filterButtonRef = useRef<HTMLButtonElement | null>(null)
  const filterPopoverRef = useRef<HTMLDivElement | null>(null)
  const newCollectionInputRef = useRef<HTMLInputElement | null>(null)
  const outputFormatMenuRef = useRef<HTMLDivElement | null>(null)
  const copyMenuRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchRequestIdRef = useRef(0)
  const settingsMutationQueueRef = useRef(Promise.resolve())
  const threadOrganizationMutationQueueRef = useRef(Promise.resolve())
  const toastSequenceRef = useRef(0)
  const toastHideTimerRef = useRef<number | null>(null)
  const toastClearTimerRef = useRef<number | null>(null)
  const resolvedSidebarWidth = isSidebarCollapsed
    ? 0
    : clampSidebarWidth(sidebarWidth, viewportWidth)
  const workspaceStyle = useMemo(
    () =>
      ({
        "--section-rail-width": `${SECTION_RAIL_WIDTH}px`,
        "--sidebar-width": `${resolvedSidebarWidth}px`
      }) as CSSProperties,
    [resolvedSidebarWidth]
  )

  const hasActiveSidebarFilters = useMemo(
    () => !isDefaultSidebarFilters(sidebarFilters),
    [sidebarFilters]
  )
  const hasActiveSearchFilters = useMemo(
    () => !isDefaultSearchFilters(searchFilters),
    [searchFilters]
  )
  const preProjectFilteredSessions = useMemo(() => {
    const now = Date.now()

    return sessions.filter(
      session =>
        matchesDateFilter(session, sidebarFilters.dateRange, now) &&
        matchesArchivedFilter(session, sidebarFilters.archived) &&
        matchesProviderFilter(session, sidebarFilters.provider)
    )
  }, [
    sessions,
    sidebarFilters.archived,
    sidebarFilters.dateRange,
    sidebarFilters.provider
  ])
  const projectOptions = useMemo(() => {
    const optionsByPath = new Map<string, ProjectFilterOption>()

    for (const session of preProjectFilteredSessions) {
      if (!session.projectPath) {
        continue
      }

      optionsByPath.set(session.projectPath, {
        path: session.projectPath,
        label: formatProjectFilterLabel(session.projectPath)
      })
    }

    for (const projectPath of sidebarFilters.projectPaths) {
      if (optionsByPath.has(projectPath)) {
        continue
      }

      optionsByPath.set(projectPath, {
        path: projectPath,
        label: formatProjectFilterLabel(projectPath)
      })
    }

    return [...optionsByPath.values()].sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.path.localeCompare(right.path)
    )
  }, [preProjectFilteredSessions, sidebarFilters.projectPaths])
  const filteredSessions = useMemo(() => {
    if (sidebarFilters.projectPaths.length === 0) {
      return preProjectFilteredSessions
    }

    const selectedProjectPaths = new Set(sidebarFilters.projectPaths)
    return preProjectFilteredSessions.filter(
      session =>
        session.projectPath !== null && selectedProjectPaths.has(session.projectPath)
    )
  }, [preProjectFilteredSessions, sidebarFilters.projectPaths])
  const sortedFilteredSessions = useMemo(
    () => sortSessionsByThreadKey(filteredSessions, threadOrganization.sortKey),
    [filteredSessions, threadOrganization.sortKey]
  )
  const projectSidebarGroups = useMemo(
    () =>
      buildProjectSidebarGroups({
        sessions: filteredSessions,
        organization: threadOrganization
      }),
    [filteredSessions, threadOrganization]
  )
  const collectionSidebarGroups = useMemo(
    () =>
      buildCollectionSidebarGroups({
        sessions: filteredSessions,
        organization: threadOrganization
      }),
    [filteredSessions, threadOrganization]
  )
  const visibleThreadGroups = useMemo(() => {
    if (threadOrganization.viewMode === "project") {
      return projectSidebarGroups
    }

    if (threadOrganization.viewMode === "collection") {
      return collectionSidebarGroups
    }

    return []
  }, [
    collectionSidebarGroups,
    projectSidebarGroups,
    threadOrganization.viewMode
  ])
  const visibleSidebarSessionIds = useMemo(() => {
    if (threadOrganization.viewMode === "chronological") {
      return new Set(sortedFilteredSessions.map(session => session.id))
    }

    return new Set(
      visibleThreadGroups.flatMap(group => group.sessions.map(session => session.id))
    )
  }, [sortedFilteredSessions, threadOrganization.viewMode, visibleThreadGroups])
  const preProjectSearchSessions = useMemo(() => {
    const now = Date.now()

    return sessions.filter(
      session =>
        matchesDateFilter(session, searchFilters.dateRange, now) &&
        matchesArchivedFilter(session, searchFilters.archived) &&
        matchesProviderFilter(session, searchFilters.provider)
    )
  }, [
    sessions,
    searchFilters.archived,
    searchFilters.dateRange,
    searchFilters.provider
  ])
  const searchProjectOptions = useMemo(() => {
    const optionsByPath = new Map<string, ProjectFilterOption>()

    for (const session of preProjectSearchSessions) {
      if (!session.projectPath) {
        continue
      }

      optionsByPath.set(session.projectPath, {
        path: session.projectPath,
        label: formatProjectFilterLabel(session.projectPath)
      })
    }

    for (const projectPath of searchFilters.projectPaths) {
      if (optionsByPath.has(projectPath)) {
        continue
      }

      optionsByPath.set(projectPath, {
        path: projectPath,
        label: formatProjectFilterLabel(projectPath)
      })
    }

    return [...optionsByPath.values()].sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.path.localeCompare(right.path)
    )
  }, [preProjectSearchSessions, searchFilters.projectPaths])
  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions]
  )
  const sortedAgents = useMemo(() => sortAgentsByName(agents), [agents])
  const selectedAgent = useMemo(
    () => agents.find(agent => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  )
  const selectedAgentRuns = useMemo(
    () => agentRuns.filter(run => run.agentId === selectedAgentId),
    [agentRuns, selectedAgentId]
  )
  const activeProjectPath =
    activeTranscript && activeTranscript.id === activeSession?.id
      ? activeTranscript.projectPath ?? activeTranscript.sessionCwd ?? null
      : null
  const activeProvider =
    activeTranscript && activeTranscript.id === activeSession?.id
      ? activeTranscript.provider
      : activeSession?.provider ?? null
  const activeProviderLabel = activeProvider ? formatProviderLabel(activeProvider) : null
  const selectableSourceSessions = useMemo(
    () => sessions.filter(session => Boolean(session.sessionPath)),
    [sessions]
  )
  const newThreadProjectOptions = useMemo(() => {
    const optionsByPath = new Map<string, ProjectFilterOption>()

    for (const session of sessions) {
      if (!session.projectPath) {
        continue
      }

      if (!optionsByPath.has(session.projectPath)) {
        optionsByPath.set(session.projectPath, {
          path: session.projectPath,
          label: formatProjectFilterLabel(session.projectPath)
        })
      }
    }

    if (newThreadDraft.projectPath && !optionsByPath.has(newThreadDraft.projectPath)) {
      optionsByPath.set(newThreadDraft.projectPath, {
        path: newThreadDraft.projectPath,
        label: formatProjectFilterLabel(newThreadDraft.projectPath)
      })
    }

    return [...optionsByPath.values()].sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.path.localeCompare(right.path)
    )
  }, [newThreadDraft.projectPath, sessions])
  const selectedNewThreadSourceSession = useMemo(
    () =>
      selectableSourceSessions.find(session => session.id === newThreadDraft.sourceSessionId) ??
      null,
    [newThreadDraft.sourceSessionId, selectableSourceSessions]
  )
  const newThreadSourceResults = useMemo(() => {
    const normalizedQuery = newThreadSourceQuery.trim().toLowerCase()
    const baseSessions =
      normalizedQuery.length === 0 ? selectableSourceSessions.slice(0, 10) : selectableSourceSessions

    return baseSessions
      .filter(session => {
        if (!normalizedQuery) {
          return true
        }

        const haystack = [
          session.threadName,
          session.projectPath ?? "",
          formatProviderLabel(session.provider)
        ]
          .join(" ")
          .toLowerCase()

        return haystack.includes(normalizedQuery)
      })
      .slice(0, 10)
  }, [newThreadSourceQuery, selectableSourceSessions])
  const generatedNewThreadPrompt = useMemo(() => {
    return buildNewThreadPrompt({
      projectPath: newThreadDraft.projectPath,
      session:
        selectedNewThreadSourceSession &&
        newThreadSourceTranscript &&
        newThreadSourceTranscript.id === selectedNewThreadSourceSession.id
          ? selectedNewThreadSourceSession
          : null,
      transcript:
        selectedNewThreadSourceSession &&
        newThreadSourceTranscript &&
        newThreadSourceTranscript.id === selectedNewThreadSourceSession.id
          ? newThreadSourceTranscript
          : null,
      draft: newThreadDraft
    })
  }, [newThreadDraft, newThreadSourceTranscript, selectedNewThreadSourceSession])

  const showToast = useCallback(
    (message: string, tone: "success" | "error" = "success") => {
      toastSequenceRef.current += 1
      const toastId = toastSequenceRef.current

      if (toastHideTimerRef.current) {
        window.clearTimeout(toastHideTimerRef.current)
      }

      if (toastClearTimerRef.current) {
        window.clearTimeout(toastClearTimerRef.current)
      }

      setToastState({
        id: toastId,
        message,
        tone,
        visible: true
      })

      toastHideTimerRef.current = window.setTimeout(() => {
        setToastState(current =>
          current && current.id === toastId ? { ...current, visible: false } : current
        )
      }, 1800)

      toastClearTimerRef.current = window.setTimeout(() => {
        setToastState(current =>
          current && current.id === toastId ? null : current
        )
      }, 2100)
    },
    []
  )
  const selectorSection = useSelectorSection({ showToast })

  const loadSettingsSnapshot = useCallback(async () => {
    const api = getHandoffApi()
    if (!api) {
      setSettingsSnapshot(null)
      setSettingsError("The preload bridge did not load. Restart the app.")
      return
    }

    try {
      const nextSettingsSnapshot = await api.settings.get()
      setSettingsSnapshot(nextSettingsSnapshot)
      setSettingsError(null)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to load settings."
      setSettingsSnapshot(null)
      setSettingsError(message)
    }
  }, [])

  const loadThreadOrganization = useCallback(async () => {
    const api = getHandoffApi()
    if (!api) {
      return
    }

    try {
      const nextOrganization = await api.threads.get()
      setThreadOrganization(cloneThreadOrganization(nextOrganization))
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Unable to load thread organization.",
        "error"
      )
    }
  }, [showToast])

  const persistThreadOrganization = useCallback(
    (updater: (current: ThreadOrganizationSettings) => ThreadOrganizationSettings) => {
      setThreadOrganization(currentOrganization => {
        const nextOrganization = updater(currentOrganization)
        const normalizedOrganization = cloneThreadOrganization(nextOrganization)
        const api = getHandoffApi()

        if (!api) {
          return normalizedOrganization
        }

        threadOrganizationMutationQueueRef.current = threadOrganizationMutationQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            try {
              const persistedOrganization = await api.threads.update(normalizedOrganization)
              setThreadOrganization(cloneThreadOrganization(persistedOrganization))
            } catch (error) {
              showToast(
                error instanceof Error
                  ? error.message
                  : "Unable to save thread organization.",
                "error"
              )
              try {
                const restoredOrganization = await api.threads.get()
                setThreadOrganization(cloneThreadOrganization(restoredOrganization))
              } catch {
                return
              }
            }
          })

        return normalizedOrganization
      })
    },
    [showToast]
  )

  const loadBridgeInfo = useCallback(async () => {
    const api = getHandoffApi()
    if (!api) {
      setBridgeStatus(null)
      setBridgeSnippets(null)
      setBridgeError("The preload bridge did not load. Restart the app.")
      return
    }

    try {
      const [nextBridgeStatus, nextBridgeSnippets] = await Promise.all([
        api.bridge.getStatus(),
        api.bridge.getConfigSnippets()
      ])
      setBridgeStatus(nextBridgeStatus)
      setBridgeSnippets(nextBridgeSnippets)
      setBridgeError(null)
    } catch (error) {
      setBridgeStatus(null)
      setBridgeSnippets(null)
      setBridgeError(error instanceof Error ? error.message : "Unable to load agent bridge.")
    }
  }, [])

  const loadSkillsStatus = useCallback(async () => {
    const api = getHandoffApi()
    if (!api) {
      setSkillsStatus(null)
      setSkillsError("The preload bridge did not load. Restart the app.")
      return
    }

    try {
      const nextSkillsStatus = await api.skills.getStatus()
      setSkillsStatus(nextSkillsStatus)
      setSkillsError(null)
    } catch (error) {
      setSkillsStatus(null)
      setSkillsError(error instanceof Error ? error.message : "Unable to load skills status.")
    }
  }, [])

  const loadAgents = useCallback(async () => {
    setIsLoadingAgents(true)
    const api = getHandoffApi()

    if (!api) {
      setAgents([])
      setAgentsError("The preload bridge did not load. Restart the app.")
      setSelectedAgentId(null)
      setIsLoadingAgents(false)
      return
    }

    try {
      const nextAgents = await api.agents.list()
      setAgents(nextAgents)
      setAgentsError(null)
      setSelectedAgentId(currentSelectedId => {
        if (currentSelectedId && nextAgents.some(agent => agent.id === currentSelectedId)) {
          return currentSelectedId
        }
        return null
      })
    } catch (error) {
      setAgents([])
      setAgentsError(error instanceof Error ? error.message : "Unable to load agents.")
      setSelectedAgentId(null)
    } finally {
      setIsLoadingAgents(false)
    }
  }, [])

  const loadAgentRuns = useCallback(async () => {
    setIsLoadingAgentRuns(true)
    const api = getHandoffApi()

    if (!api) {
      setAgentRuns([])
      setAgentRunsError("The preload bridge did not load. Restart the app.")
      setIsLoadingAgentRuns(false)
      return
    }

    try {
      const nextRuns = sortAgentRunsByStartedAt(await api.bridge.listRuns(undefined, 100))
      setAgentRuns(nextRuns)
      setAgentRunsError(null)
    } catch (error) {
      setAgentRuns([])
      setAgentRunsError(error instanceof Error ? error.message : "Unable to load agent runs.")
    } finally {
      setIsLoadingAgentRuns(false)
    }
  }, [])

  const loadSessions = useCallback(
    async (preferredSessionId?: string | null) => {
      setIsLoadingSessions(true)
      const api = getHandoffApi()

      if (!api) {
        setSessions([])
        setListError("The preload bridge did not load. Restart the app.")
        setActiveSessionId(null)
        setIsLoadingSessions(false)
        return
      }

      try {
        const nextSessions = await api.sessions.list()
        setSessions(nextSessions)
        setListError(null)

        const nextActiveId =
          preferredSessionId &&
          nextSessions.some(session => session.id === preferredSessionId)
            ? preferredSessionId
            : nextSessions[0]?.id ?? null

        setActiveSessionId(nextActiveId)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to load sessions."
        setSessions([])
        setListError(message)
        setActiveSessionId(null)
      } finally {
        setIsLoadingSessions(false)
      }
    },
    []
  )

  const loadConversation = useCallback(async (session: SessionListItem | null) => {
    if (!session) {
      setActiveTranscript(null)
      setConversationError(null)
      return
    }

    if (!session.sessionPath) {
      setActiveTranscript(null)
      setConversationError(null)
      return
    }

    setIsLoadingConversation(true)
    const api = getHandoffApi()

    if (!api) {
      setActiveTranscript(null)
      setConversationError("The preload bridge did not load. Restart the app.")
      setIsLoadingConversation(false)
      return
    }

    try {
      const transcript = await api.sessions.getTranscript(session.id, {
        includeCommentary: false,
        includeDiffs: true
      })
      setActiveTranscript(transcript)
      setConversationError(null)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to load conversation."
      setActiveTranscript(null)
      setConversationError(message)
    } finally {
      setIsLoadingConversation(false)
    }
  }, [])

  const copyMarkdown = useCallback(
    async (text: string, successLabel: string) => {
      const api = getHandoffApi()
      if (!api) {
        showToast("Preload bridge unavailable", "error")
        return
      }

      try {
        await api.clipboard.writeText(text)
        showToast(successLabel)
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "Unable to copy to clipboard.",
          "error"
        )
      }
    },
    [showToast]
  )

  const copyTextValue = useCallback(
    async (text: string, successLabel: string) => {
      const trimmed = text.trim()
      if (!trimmed) {
        return
      }

      const api = getHandoffApi()
      if (!api) {
        showToast("Preload bridge unavailable", "error")
        return
      }

      try {
        await api.clipboard.writeText(trimmed)
        showToast(`Copied ${successLabel}`)
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "Unable to copy to clipboard.",
          "error"
        )
      }
    },
    [showToast]
  )

  const handleCopyAction = useCallback(
    async (action: CopyActionKey) => {
      if (!activeTranscript) {
        return
      }

      const output = serializeConversationOutput(
        activeTranscript,
        selectedOutputFormat,
        action
      )

      if (!output.trim()) {
        return
      }

      const actionLabel =
        action === "chat"
          ? "chat"
          : action === "chat-with-diffs"
            ? "chat + diffs"
            : "last message"

      const formatLabel =
        selectedOutputFormat === "markdown"
          ? "Markdown"
          : selectedOutputFormat === "json"
            ? "JSON"
            : "Structured"

      await copyMarkdown(output, `Copied ${actionLabel} as ${formatLabel}`)
    },
    [activeTranscript, copyMarkdown, selectedOutputFormat]
  )

  const handleCopyChat = useCallback(async () => {
    if (!activeTranscript) {
      return
    }

    await handleCopyAction("chat")
  }, [activeTranscript, handleCopyAction])

  const handleCopyChatWithDiffs = useCallback(async () => {
    if (!activeTranscript) {
      return
    }

    await handleCopyAction("chat-with-diffs")
  }, [activeTranscript, handleCopyAction])

  const handleCopyLastMessage = useCallback(async () => {
    if (!activeTranscript?.lastAssistantMarkdown) {
      return
    }

    await handleCopyAction("last-message")
  }, [activeTranscript, handleCopyAction])

  const handleNewThreadDraftChange = useCallback((patch: Partial<NewThreadDraft>) => {
    setNewThreadDraft(current => ({
      ...{
        ...current,
        ...patch
      },
      ...normalizeComposerTarget({
        provider: patch.vendor ?? current.vendor,
        launchMode: patch.launchMode ?? current.launchMode,
        modelId: patch.modelId ?? current.modelId,
        fast: patch.fast ?? current.fast
      })
    }))

    if ("prompt" in patch) {
      setNewThreadPromptError(null)
    }

    if ("includeDiffs" in patch) {
      try {
        window.localStorage.setItem(
          NEW_THREAD_INCLUDE_DIFFS_STORAGE_KEY,
          patch.includeDiffs ? "true" : "false"
        )
      } catch {
        // Ignore localStorage write failures.
      }
    }

    if (
      "vendor" in patch ||
      "modelId" in patch ||
      "launchMode" in patch ||
      "thinkingLevel" in patch ||
      "fast" in patch
    ) {
      setHasTouchedNewThreadTarget(true)
    }
  }, [])

  const handleNewThreadSourceQueryChange = useCallback((value: string) => {
    setNewThreadSourceQuery(value)
    setNewThreadSourceError(null)
  }, [])

  const handleSelectNewThreadSource = useCallback(
    (session: SessionListItem | null) => {
      setNewThreadSourceError(null)
      setNewThreadPromptError(null)

      if (!session) {
        setNewThreadSourceQuery("")
        setNewThreadSourceTranscript(null)
        setNewThreadDraft(current => ({
          ...current,
          sourceSessionId: null,
          includeDiffs: false
        }))
        return
      }

      const seededTarget = getSeededNewThreadTarget({
        provider: session.provider,
        sessionClient:
          activeTranscript?.id === session.id ? activeTranscript.sessionClient : undefined,
        fast: false
      })

      setNewThreadSourceQuery("")
      setNewThreadDraft(current => ({
        ...current,
        sourceSessionId: session.id,
        projectPath: session.projectPath ?? null,
        ...(!hasTouchedNewThreadTarget
          ? {
              vendor: session.provider,
              ...seededTarget
            }
          : {})
      }))
    },
    [activeTranscript, hasTouchedNewThreadTarget]
  )

  const handleCopyNewThreadPrompt = useCallback(async () => {
    if (!generatedNewThreadPrompt.trim()) {
      return
    }

    await copyMarkdown(generatedNewThreadPrompt, "Copied prompt")
  }, [copyMarkdown, generatedNewThreadPrompt])

  const handleStartNewThread = useCallback(async () => {
    if (!generatedNewThreadPrompt.trim()) {
      setNewThreadPromptError(
        "Select a source thread or add custom instructions before starting."
      )
      return
    }

    if (!newThreadDraft.projectPath) {
      setNewThreadPromptError("Select a project before starting.")
      return
    }

    const api = getHandoffApi()
    if (!api) {
      showToast("Preload bridge unavailable", "error")
      return
    }

    try {
      setNewThreadPromptError(null)

      const params: NewThreadLaunchParams = {
        provider: newThreadDraft.vendor,
        launchMode: newThreadDraft.launchMode,
        modelId: newThreadDraft.modelId,
        projectPath: newThreadDraft.projectPath,
        prompt: generatedNewThreadPrompt,
        thinkingLevel: newThreadDraft.thinkingLevel,
        fast: newThreadDraft.vendor === "codex" ? newThreadDraft.fast : false
      }

      const result = await api.app.startNewThread(params)
      const providerLabel = formatComposerProviderLabel(newThreadDraft.vendor)

      if (result.fallbackMessage) {
        showToast(result.fallbackMessage)
        return
      }

      if (result.launchMode === "app") {
        showToast(`Prompt copied and opened ${providerLabel}`)
        return
      }

      showToast(
        newThreadDraft.vendor === "claude"
          ? `Started ${providerLabel}`
          : `Started ${providerLabel} ${formatLaunchModeLabel(result.launchMode)}`
      )
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Unable to start the new thread.",
        "error"
      )
    }
  }, [generatedNewThreadPrompt, newThreadDraft, showToast])

  const copyActions = useMemo(
    () => [
      {
        key: "chat-with-diffs" as const,
        label: "Copy Chat + Diffs",
        disabled: !activeTranscript?.markdown,
        run: handleCopyChatWithDiffs
      },
      {
        key: "chat" as const,
        label: "Copy Chat",
        disabled: !activeSession?.sessionPath,
        run: handleCopyChat
      },
      {
        key: "last-message" as const,
        label: "Copy Last Message",
        disabled: !activeTranscript?.lastAssistantMarkdown,
        run: handleCopyLastMessage
      }
    ],
    [
      activeSession?.sessionPath,
      activeTranscript?.lastAssistantMarkdown,
      activeTranscript?.markdown,
      handleCopyChat,
      handleCopyChatWithDiffs,
      handleCopyLastMessage
    ]
  )
  const selectedOutputFormatOption =
    OUTPUT_FORMAT_OPTIONS.find(option => option.key === selectedOutputFormat) ??
    OUTPUT_FORMAT_OPTIONS[0]
  const selectedCopyActionOption =
    copyActions.find(action => action.key === selectedCopyAction) ?? copyActions[0]
  const alternateCopyActions = copyActions.filter(
    action => action.key !== selectedCopyActionOption.key
  )

  const handleOpenInSource = useCallback(async () => {
    if (!activeSession?.id || activeTranscript?.id !== activeSession.id) {
      return
    }

    const api = getHandoffApi()
    if (!api) {
      showToast("Preload bridge unavailable", "error")
      return
    }

    try {
      const providerLabel = formatProviderLabel(activeTranscript.provider)

      const result = await api.app.openSourceSession(
        activeTranscript.provider,
        activeTranscript.sourceSessionId,
        activeTranscript.sessionClient,
        activeTranscript.projectPath ?? activeTranscript.sessionCwd
      )
      showToast(result.fallbackMessage ?? `Opened in ${providerLabel}`)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Unable to open ${formatProviderLabel(activeTranscript.provider)}`
      showToast(message, "error")
    }
  }, [activeSession, activeTranscript, showToast])

  const handleOpenProjectPath = useCallback(
    async (target: ProjectLocationTarget) => {
      if (!activeProjectPath) {
        return
      }

      const api = getHandoffApi()
      if (!api) {
        showToast("Preload bridge unavailable", "error")
        return
      }

      const targetLabel = formatProjectLocationLabel(target)

      try {
        const result = await api.app.openProjectPath(target, activeProjectPath)
        showToast(result.fallbackMessage ?? `Opened in ${targetLabel}`)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `Unable to open ${targetLabel}`
        showToast(message, "error")
      }
    },
    [activeProjectPath, showToast]
  )

  const handleSettingsPatch = useCallback(
    (patch: HandoffSettingsPatch) => {
      const api = getHandoffApi()
      if (!api) {
        showToast("Preload bridge unavailable", "error")
        return
      }

      setSettingsSnapshot(current =>
        current ? applySettingsPatchToSnapshot(current, patch) : current
      )

      settingsMutationQueueRef.current = settingsMutationQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const nextSettingsSnapshot = await api.settings.update(patch)
          setSettingsSnapshot(nextSettingsSnapshot)
          setSettingsError(null)
          await loadSkillsStatus()
        })
        .catch(async error => {
          showToast(
            error instanceof Error ? error.message : "Unable to update settings.",
            "error"
          )
          await loadSettingsSnapshot()
        })
    },
    [loadSettingsSnapshot, loadSkillsStatus, showToast]
  )

  const handleProviderOverrideChange = useCallback(
    (provider: SessionProvider, patch: Partial<ProviderLaunchOverrides>) => {
      handleSettingsPatch({
        providers: {
          [provider]: patch
        }
      })
    },
    [handleSettingsPatch]
  )

  const handleProviderReset = useCallback(
    (provider: SessionProvider) => {
      const api = getHandoffApi()
      if (!api) {
        showToast("Preload bridge unavailable", "error")
        return
      }

      settingsMutationQueueRef.current = settingsMutationQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const nextSettingsSnapshot = await api.settings.resetProvider(provider)
          setSettingsSnapshot(nextSettingsSnapshot)
          setSettingsError(null)
          await loadSkillsStatus()
        })
        .catch(async error => {
          showToast(
            error instanceof Error ? error.message : "Unable to reset settings.",
            "error"
          )
          await loadSettingsSnapshot()
        })
    },
    [loadSettingsSnapshot, loadSkillsStatus, showToast]
  )

  const handleTerminalToggle = useCallback(
    (terminalId: TerminalAppId) => {
      const currentSettings = settingsSnapshot?.settings.terminals
      if (!currentSettings) {
        return
      }

      const enabledTerminalIds = currentSettings.enabledTerminalIds.includes(terminalId)
        ? currentSettings.enabledTerminalIds.filter(id => id !== terminalId)
        : [...currentSettings.enabledTerminalIds, terminalId]

      handleSettingsPatch({
        terminals: {
          enabledTerminalIds
        }
      })
    },
    [handleSettingsPatch, settingsSnapshot]
  )

  const handleDefaultTerminalSelect = useCallback(
    (terminalId: TerminalAppId) => {
      handleSettingsPatch({
        terminals: {
          defaultTerminalId: terminalId
        }
      })
    },
    [handleSettingsPatch]
  )

  const handleSkillToolTimeoutChange = useCallback(
    (provider: SessionProvider, timeoutSec: number | null) => {
      handleSettingsPatch({
        skills: {
          [provider]: {
            toolTimeoutSec: timeoutSec
          }
        }
      })
    },
    [handleSettingsPatch]
  )

  const toggleThoughtChainEntry = useCallback((entryId: string) => {
    setExpandedThoughtChainIds(current => {
      const next = new Set(current)
      if (next.has(entryId)) {
        next.delete(entryId)
      } else {
        next.add(entryId)
      }

      return next
    })
  }, [])

  useEffect(() => {
    let isMounted = true

    async function initialize() {
      const api = getHandoffApi()
      if (!api) {
        throw new Error("The preload bridge did not load. Restart the app.")
      }

      const info = await api.app.getStateInfo()
      if (!isMounted) {
        return
      }

      setStateInfo(info)
      try {
        const nextSettingsSnapshot = await api.settings.get()
        if (!isMounted) {
          return
        }

        setSettingsSnapshot(nextSettingsSnapshot)
        setSettingsError(null)
      } catch (error) {
        if (!isMounted) {
          return
        }

        setSettingsSnapshot(null)
        setSettingsError(
          error instanceof Error ? error.message : "Unable to load settings."
        )
      }
      try {
        const nextSearchStatus = await api.search.getStatus()
        if (!isMounted) {
          return
        }

        setSearchStatus(nextSearchStatus)
      } catch (error) {
        if (!isMounted) {
          return
        }

        setSearchStatus({
          state: "error",
          message: error instanceof Error ? error.message : "Search unavailable.",
          indexedAt: null,
          documentCount: 0
        })
      }
      await Promise.all([
        loadSessions(),
        loadAgents(),
        loadBridgeInfo(),
        loadSkillsStatus(),
        loadThreadOrganization()
      ])
    }

    initialize().catch(error => {
      const message =
        error instanceof Error ? error.message : "Unable to initialize app."
      setListError(message)
      setIsLoadingSessions(false)
    })

    return () => {
      isMounted = false
    }
  }, [loadAgents, loadBridgeInfo, loadSessions, loadSkillsStatus, loadThreadOrganization])

  useEffect(() => {
    const api = getHandoffApi()
    if (!api) {
      return () => undefined
    }

    return api.search.onStatusChanged(nextStatus => {
      setSearchStatus(nextStatus)
    })
  }, [])

  useEffect(() => {
    void loadConversation(activeSession)
  }, [activeSession, loadConversation])

  useEffect(() => {
    setAgentDraft(cloneAgentDefinition(selectedAgent))
    setAgentEditorError(null)
  }, [selectedAgent])

  useEffect(() => {
    if (activeSection !== "agents" || isSettingsOpen) {
      return
    }

    void loadAgentRuns()
  }, [activeSection, isSettingsOpen, loadAgentRuns])

  useEffect(() => {
    if (activeSection !== "agents" || isSettingsOpen) {
      return () => undefined
    }

    if (!agentRuns.some(run => run.status === "running")) {
      return () => undefined
    }

    const intervalId = window.setInterval(() => {
      void loadAgentRuns()
    }, 4_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [activeSection, agentRuns, isSettingsOpen, loadAgentRuns])

  useEffect(() => {
    const session = selectedNewThreadSourceSession

    if (!session) {
      setIsLoadingNewThreadSource(false)
      setNewThreadSourceTranscript(null)
      setNewThreadSourceError(null)
      return
    }

    if (!session.sessionPath) {
      setIsLoadingNewThreadSource(false)
      setNewThreadSourceTranscript(null)
      setNewThreadSourceError("This thread does not have a readable session file.")
      return
    }

    if (activeTranscript?.id === session.id) {
      setIsLoadingNewThreadSource(false)
      setNewThreadSourceTranscript(activeTranscript)
      setNewThreadSourceError(null)
      return
    }

    const api = getHandoffApi()
    if (!api) {
      setIsLoadingNewThreadSource(false)
      setNewThreadSourceTranscript(null)
      setNewThreadSourceError("The preload bridge did not load. Restart the app.")
      return
    }

    let isCancelled = false
    setIsLoadingNewThreadSource(true)

    void api.sessions
      .getTranscript(session.id, {
        includeCommentary: false,
        includeDiffs: true
      })
      .then(transcript => {
        if (isCancelled) {
          return
        }

        setNewThreadSourceTranscript(transcript)
        setNewThreadSourceError(null)
      })
      .catch(error => {
        if (isCancelled) {
          return
        }

        setNewThreadSourceTranscript(null)
        setNewThreadSourceError(
          error instanceof Error ? error.message : "Unable to load the source thread."
        )
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingNewThreadSource(false)
        }
      })

    return () => {
      isCancelled = true
    }
  }, [activeTranscript, selectedNewThreadSourceSession])

  useEffect(() => {
    if (
      !selectedNewThreadSourceSession ||
      !newThreadSourceTranscript ||
      newThreadSourceTranscript.id !== selectedNewThreadSourceSession.id
    ) {
      return
    }

    const resolvedProjectPath =
      newThreadSourceTranscript.projectPath ??
      newThreadSourceTranscript.sessionCwd ??
      selectedNewThreadSourceSession.projectPath

    if (!resolvedProjectPath) {
      return
    }

    setNewThreadDraft(current => {
      if (
        current.projectPath &&
        current.projectPath !== selectedNewThreadSourceSession.projectPath &&
        current.projectPath !== resolvedProjectPath
      ) {
        return current
      }

      return current.projectPath === resolvedProjectPath
        ? current
        : {
            ...current,
            projectPath: resolvedProjectPath
          }
    })
  }, [newThreadSourceTranscript, selectedNewThreadSourceSession])

  useEffect(() => {
    if (
      hasTouchedNewThreadTarget ||
      !selectedNewThreadSourceSession ||
      !newThreadSourceTranscript ||
      newThreadSourceTranscript.id !== selectedNewThreadSourceSession.id
    ) {
      return
    }

    const seededTarget = getSeededNewThreadTarget({
      provider: selectedNewThreadSourceSession.provider,
      sessionClient: newThreadSourceTranscript.sessionClient,
      fast: false
    })

    setNewThreadDraft(current => {
      if (
        current.vendor === selectedNewThreadSourceSession.provider &&
        current.launchMode === seededTarget.launchMode &&
        current.modelId === seededTarget.modelId &&
        current.fast === seededTarget.fast
      ) {
        return current
      }

      return {
        ...current,
        vendor: selectedNewThreadSourceSession.provider,
        ...seededTarget
      }
    })
  }, [
    hasTouchedNewThreadTarget,
    newThreadSourceTranscript,
    selectedNewThreadSourceSession
  ])

  useEffect(() => {
    if (activeSection !== "threads" || isSettingsOpen || rightPaneMode !== "search") {
      return
    }

    searchInputRef.current?.focus()
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
    })
  }, [activeSection, isSettingsOpen, rightPaneMode])

  useEffect(() => {
    setExpandedThoughtChainIds(new Set())
  }, [activeTranscript?.id, activeTranscript?.updatedAt])

  useEffect(() => {
    if (sessions.length === 0) {
      if (activeSessionId !== null) {
        setActiveSessionId(null)
      }
      return
    }

    if (!activeSessionId || !sessions.some(session => session.id === activeSessionId)) {
      setActiveSessionId(sessions[0]?.id ?? null)
    }
  }, [activeSessionId, sessions])

  useEffect(() => {
    if (agents.length === 0) {
      if (selectedAgentId !== null) {
        setSelectedAgentId(null)
      }
      if (agentsPaneView === "agent") {
        setAgentsPaneView("dashboard")
      }
      return
    }

    if (selectedAgentId && !agents.some(agent => agent.id === selectedAgentId)) {
      setSelectedAgentId(null)
      if (agentsPaneView === "agent") {
        setAgentsPaneView("dashboard")
      }
    }
  }, [agents, agentsPaneView, selectedAgentId])

  useEffect(() => {
    if (activeSection !== "threads" || isSettingsOpen || rightPaneMode !== "search") {
      return () => undefined
    }

    const api = getHandoffApi()
    if (!api) {
      return () => undefined
    }

    const requestId = ++searchRequestIdRef.current
    const debounceMs = searchQuery.trim().length >= 3 ? 140 : 40
    setIsSearchLoading(true)

    const timer = window.setTimeout(() => {
      void api.search
        .query({
          query: searchQuery,
          filters: searchFilters,
          limit: 50
        })
        .then(results => {
          if (searchRequestIdRef.current !== requestId) {
            return
          }

          setSearchResults(results)
        })
        .catch(error => {
          if (searchRequestIdRef.current !== requestId) {
            return
          }

          setSearchResults([])
          setSearchStatus(current => ({
            state: "error",
            message:
              error instanceof Error ? error.message : "Unable to search conversations.",
            indexedAt: current?.indexedAt ?? null,
            documentCount: current?.documentCount ?? 0
          }))
        })
        .finally(() => {
          if (searchRequestIdRef.current === requestId) {
            setIsSearchLoading(false)
          }
        })
    }, debounceMs)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    activeSection,
    isSettingsOpen,
    rightPaneMode,
    searchFilters,
    searchQuery,
    searchStatus?.indexedAt,
    sessions.length
  ])

  useEffect(() => {
    function handleResize() {
      setViewportWidth(window.innerWidth)
    }

    window.addEventListener("resize", handleResize)
    return () => {
      window.removeEventListener("resize", handleResize)
    }
  }, [])

  useEffect(() => {
    setSidebarWidth(currentWidth => clampSidebarWidth(currentWidth, viewportWidth))
  }, [viewportWidth])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_WIDTH_STORAGE_KEY,
        String(clampSidebarWidth(sidebarWidth, viewportWidth))
      )
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        isSidebarCollapsed ? "true" : "false"
      )
    } catch {
      return
    }
  }, [isSidebarCollapsed, sidebarWidth, viewportWidth])

  useEffect(() => {
    setIsCopyMenuOpen(false)
    setIsOutputFormatMenuOpen(false)
  }, [activeSection, activeSessionId, isSettingsOpen, rightPaneMode])

  useEffect(() => {
    if (!isFilterPopoverOpen) {
      return () => undefined
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }

      if (
        filterPopoverRef.current?.contains(target) ||
        filterButtonRef.current?.contains(target)
      ) {
        return
      }

      setIsFilterPopoverOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsFilterPopoverOpen(false)
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isFilterPopoverOpen])

  useEffect(() => {
    if (!isCreateCollectionDialogOpen) {
      return
    }

    newCollectionInputRef.current?.focus()
    newCollectionInputRef.current?.select()
  }, [isCreateCollectionDialogOpen])

  useEffect(() => {
    if (!isCopyMenuOpen) {
      return () => undefined
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && copyMenuRef.current?.contains(target)) {
        return
      }

      setIsCopyMenuOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsCopyMenuOpen(false)
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isCopyMenuOpen])

  useEffect(() => {
    if (!isOutputFormatMenuOpen) {
      return () => undefined
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && outputFormatMenuRef.current?.contains(target)) {
        return
      }

      setIsOutputFormatMenuOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOutputFormatMenuOpen(false)
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOutputFormatMenuOpen])

  useEffect(() => {
    return () => {
      if (toastHideTimerRef.current) {
        window.clearTimeout(toastHideTimerRef.current)
      }

      if (toastClearTimerRef.current) {
        window.clearTimeout(toastClearTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!sidebarDragState) {
      return () => undefined
    }

    const dragState = sidebarDragState

    function handlePointerMove(event: PointerEvent) {
      setSidebarWidth(
        clampSidebarWidth(
          dragState.startWidth + (event.clientX - dragState.startX),
          window.innerWidth
        )
      )
    }

    function handlePointerUp() {
      setSidebarDragState(null)
    }

    document.body.classList.add("is-resizing-sidebar")
    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)

    return () => {
      document.body.classList.remove("is-resizing-sidebar")
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }
  }, [sidebarDragState])

  useEffect(() => {
    const api = getHandoffApi()
    if (!api) {
      return () => undefined
    }

    return api.app.onStateChanged(event => {
      if (event.reason === "selected-session-changed") {
        const selectedSession =
          sessions.find(session => session.id === activeSessionId) ?? null
        void loadConversation(selectedSession)
        return
      }

      void loadSessions(activeSessionId)
    })
  }, [activeSessionId, loadConversation, loadSessions, sessions])

  const handleSidebarToggle = useCallback(() => {
    setIsSidebarCollapsed(current => !current)
  }, [])

  const handleFilterPopoverToggle = useCallback(() => {
    setIsFilterPopoverOpen(current => !current)
  }, [])

  const handleArchivedFilterChange = useCallback((value: ArchivedFilterValue) => {
    setSidebarFilters(current => ({
      ...current,
      archived: value
    }))
  }, [])

  const handleProviderFilterChange = useCallback((value: ProviderFilterValue) => {
    setSidebarFilters(current => ({
      ...current,
      provider: value
    }))
  }, [])

  const handleDateFilterChange = useCallback((value: DateRangeFilterValue) => {
    setSidebarFilters(current => ({
      ...current,
      dateRange: value
    }))
  }, [])

  const handleProjectFilterToggle = useCallback((projectPath: string) => {
    setSidebarFilters(current => ({
      ...current,
      projectPaths: current.projectPaths.includes(projectPath)
        ? current.projectPaths.filter(path => path !== projectPath)
        : [...current.projectPaths, projectPath]
    }))
  }, [])

  const handleThreadViewModeChange = useCallback(
    (viewMode: ThreadViewMode) => {
      persistThreadOrganization(currentOrganization => ({
        ...currentOrganization,
        viewMode
      }))
    },
    [persistThreadOrganization]
  )

  const handleThreadSortKeyChange = useCallback(
    (sortKey: ThreadSortKey) => {
      persistThreadOrganization(currentOrganization => ({
        ...currentOrganization,
        sortKey
      }))
    },
    [persistThreadOrganization]
  )

  const handleOpenCreateCollectionDialog = useCallback(() => {
    setNewCollectionNameDraft("New collection")
    setIsCreateCollectionDialogOpen(true)
  }, [])

  const handleCancelCreateCollection = useCallback(() => {
    setIsCreateCollectionDialogOpen(false)
    setNewCollectionNameDraft("New collection")
  }, [])

  const handleConfirmCreateCollection = useCallback(() => {
    persistThreadOrganization(currentOrganization => {
      const name = buildUniqueCollectionName(
        currentOrganization.collections,
        newCollectionNameDraft
      )
      const collectionId =
        typeof window !== "undefined" && window.crypto?.randomUUID
          ? window.crypto.randomUUID()
          : `collection-${Date.now()}`
      const nextOrganization = {
        ...currentOrganization,
        viewMode: "collection" as const,
        collections: [
          ...currentOrganization.collections,
          {
            id: collectionId,
            name,
            icon: DEFAULT_THREAD_COLLECTION_ICON,
            color: DEFAULT_THREAD_COLLECTION_COLOR,
            collapsed: false,
            order: null,
            threadIds: []
          }
        ]
      }

      return resequenceCollectionOrders(nextOrganization, [collectionId])
    })

    setIsCreateCollectionDialogOpen(false)
    setNewCollectionNameDraft("New collection")
  }, [newCollectionNameDraft, persistThreadOrganization])

  const handleOpenCollectionAppearanceEditor = useCallback(
    (collectionId: string) => {
      const collection = threadOrganization.collections.find(entry => entry.id === collectionId)
      if (!collection) {
        return
      }

      setEditingCollectionAppearanceId(collectionId)
      setCollectionAppearanceDraft({
        icon: resolveCollectionIcon(collection.icon),
        color: resolveCollectionColor(collection.color)
      })
    },
    [threadOrganization.collections]
  )

  const handleCloseCollectionAppearanceEditor = useCallback(() => {
    setEditingCollectionAppearanceId(null)
    setCollectionAppearanceDraft({
      icon: DEFAULT_THREAD_COLLECTION_ICON,
      color: DEFAULT_THREAD_COLLECTION_COLOR
    })
  }, [])

  const handleSaveCollectionAppearance = useCallback(() => {
    if (!editingCollectionAppearanceId) {
      return
    }

    persistThreadOrganization(currentOrganization => ({
      ...currentOrganization,
      collections: currentOrganization.collections.map(collection =>
        collection.id === editingCollectionAppearanceId
          ? {
              ...collection,
              icon: resolveCollectionIcon(collectionAppearanceDraft.icon),
              color: resolveCollectionColor(collectionAppearanceDraft.color)
            }
          : collection
      )
    }))

    handleCloseCollectionAppearanceEditor()
  }, [
    collectionAppearanceDraft.color,
    collectionAppearanceDraft.icon,
    editingCollectionAppearanceId,
    handleCloseCollectionAppearanceEditor,
    persistThreadOrganization
  ])

  const handleRenameProjectAlias = useCallback(
    (projectPath: string) => {
      const currentAlias = threadOrganization.projects[projectPath]?.alias ?? ""
      const nextAlias = window.prompt("Project name", currentAlias || formatProjectFilterLabel(projectPath))
      if (nextAlias === null) {
        return
      }

      persistThreadOrganization(currentOrganization => ({
        ...currentOrganization,
        projects: {
          ...currentOrganization.projects,
          [projectPath]: {
            projectPath,
            alias: nextAlias.trim(),
            collapsed: currentOrganization.projects[projectPath]?.collapsed ?? false,
            order: currentOrganization.projects[projectPath]?.order ?? null,
            threadOrder: [...(currentOrganization.projects[projectPath]?.threadOrder ?? [])]
          }
        }
      }))
    },
    [persistThreadOrganization, threadOrganization.projects]
  )

  const handleToggleProjectCollapsed = useCallback(
    (projectPath: string) => {
      persistThreadOrganization(currentOrganization => {
        const currentState = currentOrganization.projects[projectPath]
        return {
          ...currentOrganization,
          projects: {
            ...currentOrganization.projects,
            [projectPath]: {
              projectPath,
              alias: currentState?.alias ?? "",
              collapsed: !(currentState?.collapsed ?? false),
              order: currentState?.order ?? null,
              threadOrder: [...(currentState?.threadOrder ?? [])]
            }
          }
        }
      })
    },
    [persistThreadOrganization]
  )

  const handleRenameCollection = useCallback(
    (collectionId: string) => {
      const collection = threadOrganization.collections.find(entry => entry.id === collectionId)
      if (!collection) {
        return
      }

      const nextName = window.prompt("Collection name", collection.name)
      if (nextName === null) {
        return
      }

      const trimmedName = nextName.trim()
      if (!trimmedName) {
        return
      }

      persistThreadOrganization(currentOrganization => ({
        ...currentOrganization,
        collections: currentOrganization.collections.map(entry =>
          entry.id === collectionId
            ? {
                ...entry,
                name: trimmedName
              }
            : entry
        )
      }))
    },
    [persistThreadOrganization, threadOrganization.collections]
  )

  const handleDeleteCollection = useCallback(
    (collectionId: string) => {
      const collection = threadOrganization.collections.find(entry => entry.id === collectionId)
      if (!collection) {
        return
      }

      if (!window.confirm(`Remove "${collection.name}"?`)) {
        return
      }

      persistThreadOrganization(currentOrganization => ({
        ...currentOrganization,
        collections: currentOrganization.collections.filter(entry => entry.id !== collectionId)
      }))
    },
    [persistThreadOrganization, threadOrganization.collections]
  )

  const handleToggleCollectionCollapsed = useCallback(
    (collectionId: string) => {
      persistThreadOrganization(currentOrganization => ({
        ...currentOrganization,
        collections: currentOrganization.collections.map(collection =>
          collection.id === collectionId
            ? {
                ...collection,
                collapsed: !collection.collapsed
              }
            : collection
        )
      }))
    },
    [persistThreadOrganization]
  )

  const handleSearchArchivedFilterChange = useCallback((value: ArchivedFilterValue) => {
    setSearchFilters(current => ({
      ...current,
      archived: value
    }))
  }, [])

  const handleSearchProviderFilterChange = useCallback((value: ProviderFilterValue) => {
    setSearchFilters(current => ({
      ...current,
      provider: value
    }))
  }, [])

  const handleSearchDateFilterChange = useCallback((value: DateRangeFilterValue) => {
    setSearchFilters(current => ({
      ...current,
      dateRange: value
    }))
  }, [])

  const handleSearchProjectToggle = useCallback((projectPath: string) => {
    setSearchFilters(current => ({
      ...current,
      projectPaths: current.projectPaths.includes(projectPath)
        ? current.projectPaths.filter(path => path !== projectPath)
        : [...current.projectPaths, projectPath]
    }))
  }, [])

  const handleOpenSearch = useCallback(() => {
    setActiveSection("threads")
    setIsSettingsOpen(false)
    setIsFilterPopoverOpen(false)
    setRightPaneMode("search")
  }, [])

  const handleOpenNewThread = useCallback(() => {
    setActiveSection("threads")
    setIsSettingsOpen(false)
    setIsFilterPopoverOpen(false)
    setPreviousNonComposerPaneMode(
      rightPaneMode === "new-thread" ? previousNonComposerPaneMode : rightPaneMode
    )

    const nextDraft = createDefaultNewThreadDraft()
    const seedTranscript =
      activeSession && activeTranscript?.id === activeSession.id ? activeTranscript : null

    if (activeSession) {
      const seededTarget = getSeededNewThreadTarget({
        provider: activeSession.provider,
        sessionClient: seedTranscript?.sessionClient,
        fast: false
      })

      nextDraft.sourceSessionId = activeSession.id
      nextDraft.projectPath =
        seedTranscript?.projectPath ?? seedTranscript?.sessionCwd ?? activeSession.projectPath
      nextDraft.vendor = activeSession.provider
      nextDraft.launchMode = seededTarget.launchMode
      nextDraft.modelId = seededTarget.modelId
      nextDraft.fast = seededTarget.fast
      setNewThreadSourceQuery("")
    } else {
      setNewThreadSourceQuery("")
    }

    setHasTouchedNewThreadTarget(false)
    setNewThreadPromptError(null)
    setNewThreadSourceError(null)
    setNewThreadSourceTranscript(seedTranscript)
    setNewThreadDraft(nextDraft)
    setRightPaneMode("new-thread")
  }, [activeSession, activeTranscript, previousNonComposerPaneMode, rightPaneMode])

  const handleOpenSettings = useCallback(() => {
    setIsSettingsOpen(true)
  }, [])

  const handleCloseSettings = useCallback(() => {
    setIsSettingsOpen(false)
  }, [])

  const handleCloseNewThread = useCallback(() => {
    setRightPaneMode(previousNonComposerPaneMode)
  }, [previousNonComposerPaneMode])

  const handleReturnToSearch = useCallback(() => {
    setActiveSection("threads")
    setIsSettingsOpen(false)
    setRightPaneMode("search")
  }, [])

  const handleSelectSection = useCallback((section: AppSection) => {
    setActiveSection(section)
    setIsSettingsOpen(false)
    setIsFilterPopoverOpen(false)
  }, [])

  const handleSelectSessionFromSidebar = useCallback((sessionId: string) => {
    setActiveSection("threads")
    setIsSettingsOpen(false)
    setActiveSessionId(sessionId)
    setRightPaneMode("conversation")
    setSearchReturnActive(false)
    setIsFilterPopoverOpen(false)
  }, [])

  const handleSelectSearchResult = useCallback((result: SearchResult) => {
    setActiveSection("threads")
    setIsSettingsOpen(false)
    setActiveSessionId(result.id)
    setRightPaneMode("conversation")
    setSearchReturnActive(true)
  }, [])

  const clearThreadDragState = useCallback(() => {
    setThreadDragItem(null)
    setThreadDropIndicator(null)
  }, [])

  const handleThreadDragEnd = useCallback(() => {
    clearThreadDragState()
  }, [clearThreadDragState])

  const handleProjectGroupDrop = useCallback(
    (targetProjectPath: string, event: ReactDragEvent<HTMLDivElement>) => {
      if (threadDragItem?.type !== "project-group" || threadDragItem.projectPath === targetProjectPath) {
        return
      }

      const orderedProjectPaths = projectSidebarGroups
        .filter(group => group.kind === "project" && group.projectPath)
        .map(group => group.projectPath as string)
      const nextProjectPaths = moveItemWithPosition(
        orderedProjectPaths,
        orderedProjectPaths.indexOf(threadDragItem.projectPath),
        orderedProjectPaths.indexOf(targetProjectPath),
        getVerticalDropPosition(event)
      )

      persistThreadOrganization(currentOrganization =>
        resequenceProjectOrders(currentOrganization, nextProjectPaths)
      )
      clearThreadDragState()
    },
    [clearThreadDragState, persistThreadOrganization, projectSidebarGroups, threadDragItem]
  )

  const handleProjectThreadDrop = useCallback(
    (
      targetProjectPath: string,
      targetThreadId: string,
      event: ReactDragEvent<HTMLDivElement>
    ) => {
      if (
        threadDragItem?.type !== "project-thread" ||
        threadDragItem.projectPath !== targetProjectPath
      ) {
        return
      }

      const targetGroup = projectSidebarGroups.find(group => group.projectPath === targetProjectPath)
      if (!targetGroup) {
        return
      }

      const visibleThreadIds = targetGroup.sessions.map(session => session.id)
      const nextVisibleThreadIds = moveItemWithPosition(
        visibleThreadIds,
        visibleThreadIds.indexOf(threadDragItem.threadId),
        visibleThreadIds.indexOf(targetThreadId),
        getVerticalDropPosition(event)
      )

      persistThreadOrganization(currentOrganization => {
        const currentProjectState = currentOrganization.projects[targetProjectPath]
        return {
          ...currentOrganization,
          projects: {
            ...currentOrganization.projects,
            [targetProjectPath]: {
              projectPath: targetProjectPath,
              alias: currentProjectState?.alias ?? "",
              collapsed: currentProjectState?.collapsed ?? false,
              order: currentProjectState?.order ?? null,
              threadOrder: mergeVisibleOrderWithHiddenIds(
                currentProjectState?.threadOrder ?? [],
                nextVisibleThreadIds
              )
            }
          }
        }
      })
      clearThreadDragState()
    },
    [clearThreadDragState, persistThreadOrganization, projectSidebarGroups, threadDragItem]
  )

  const handleProjectThreadAppend = useCallback(
    (targetProjectPath: string) => {
      if (
        threadDragItem?.type !== "project-thread" ||
        threadDragItem.projectPath !== targetProjectPath
      ) {
        return
      }

      const targetGroup = projectSidebarGroups.find(group => group.projectPath === targetProjectPath)
      if (!targetGroup) {
        return
      }

      const visibleThreadIds = targetGroup.sessions.map(session => session.id)
      const nextVisibleThreadIds = [
        ...visibleThreadIds.filter(threadId => threadId !== threadDragItem.threadId),
        threadDragItem.threadId
      ]

      persistThreadOrganization(currentOrganization => {
        const currentProjectState = currentOrganization.projects[targetProjectPath]
        return {
          ...currentOrganization,
          projects: {
            ...currentOrganization.projects,
            [targetProjectPath]: {
              projectPath: targetProjectPath,
              alias: currentProjectState?.alias ?? "",
              collapsed: currentProjectState?.collapsed ?? false,
              order: currentProjectState?.order ?? null,
              threadOrder: mergeVisibleOrderWithHiddenIds(
                currentProjectState?.threadOrder ?? [],
                nextVisibleThreadIds
              )
            }
          }
        }
      })
      clearThreadDragState()
    },
    [clearThreadDragState, persistThreadOrganization, projectSidebarGroups, threadDragItem]
  )

  const handleCollectionGroupDrop = useCallback(
    (targetCollectionId: string, event: ReactDragEvent<HTMLDivElement>) => {
      if (threadDragItem?.type === "collection-group") {
        if (threadDragItem.collectionId === targetCollectionId) {
          return
        }

        const orderedCollectionIds = collectionSidebarGroups
          .filter(group => group.kind === "collection" && group.collectionId)
          .map(group => group.collectionId as string)
        const nextCollectionIds = moveItemWithPosition(
          orderedCollectionIds,
          orderedCollectionIds.indexOf(threadDragItem.collectionId),
          orderedCollectionIds.indexOf(targetCollectionId),
          getVerticalDropPosition(event)
        )

        persistThreadOrganization(currentOrganization =>
          resequenceCollectionOrders(currentOrganization, nextCollectionIds)
        )
        clearThreadDragState()
        return
      }

      if (threadDragItem?.type !== "collection-thread") {
        return
      }

      const targetGroup = collectionSidebarGroups.find(group => group.collectionId === targetCollectionId)
      if (!targetGroup) {
        return
      }

      const nextVisibleThreadIds = [
        ...targetGroup.sessions
          .map(session => session.id)
          .filter(threadId => threadId !== threadDragItem.threadId),
        threadDragItem.threadId
      ]

      persistThreadOrganization(currentOrganization => {
        const nextCollections = currentOrganization.collections.map(collection => {
          if (collection.id === targetCollectionId) {
            return {
              ...collection,
              threadIds: mergeVisibleOrderWithHiddenIds(
                [...collection.threadIds.filter(id => id !== threadDragItem.threadId), threadDragItem.threadId],
                nextVisibleThreadIds
              )
            }
          }

          if (
            threadDragItem.collectionId !== null &&
            collection.id === threadDragItem.collectionId &&
            threadDragItem.collectionId !== targetCollectionId
          ) {
            return {
              ...collection,
              threadIds: collection.threadIds.filter(id => id !== threadDragItem.threadId)
            }
          }

          return collection
        })

        return {
          ...currentOrganization,
          collections: nextCollections
        }
      })
      clearThreadDragState()
    },
    [clearThreadDragState, collectionSidebarGroups, persistThreadOrganization, threadDragItem]
  )

  const handleCollectionThreadDrop = useCallback(
    (
      targetCollectionId: string | null,
      targetThreadId: string,
      event: ReactDragEvent<HTMLDivElement>
    ) => {
      if (threadDragItem?.type !== "collection-thread") {
        return
      }

      if (targetCollectionId === null) {
        if (threadDragItem.collectionId === null) {
          return
        }

        persistThreadOrganization(currentOrganization => ({
          ...currentOrganization,
          collections: currentOrganization.collections.map(collection =>
            collection.id === threadDragItem.collectionId
              ? {
                  ...collection,
                  threadIds: collection.threadIds.filter(id => id !== threadDragItem.threadId)
                }
              : collection
          )
        }))
        clearThreadDragState()
        return
      }

      const targetGroup = collectionSidebarGroups.find(group => group.collectionId === targetCollectionId)
      if (!targetGroup) {
        return
      }

      const targetVisibleThreadIds = targetGroup.sessions
        .map(session => session.id)
        .filter(threadId => threadId !== threadDragItem.threadId)
      const targetWithDraggedThread = [...targetVisibleThreadIds, threadDragItem.threadId]
      const nextTargetVisibleThreadIds = moveItemWithPosition(
        targetWithDraggedThread,
        targetWithDraggedThread.indexOf(threadDragItem.threadId),
        targetWithDraggedThread.indexOf(targetThreadId),
        getVerticalDropPosition(event)
      )

      persistThreadOrganization(currentOrganization => ({
        ...currentOrganization,
        collections: currentOrganization.collections.map(collection => {
          if (collection.id === targetCollectionId) {
            return {
              ...collection,
              threadIds: mergeVisibleOrderWithHiddenIds(
                [...collection.threadIds.filter(id => id !== threadDragItem.threadId), threadDragItem.threadId],
                nextTargetVisibleThreadIds
              )
            }
          }

          if (
            threadDragItem.collectionId !== null &&
            collection.id === threadDragItem.collectionId &&
            threadDragItem.collectionId !== targetCollectionId
          ) {
            return {
              ...collection,
              threadIds: collection.threadIds.filter(id => id !== threadDragItem.threadId)
            }
          }

          return collection
        })
      }))
      clearThreadDragState()
    },
    [clearThreadDragState, collectionSidebarGroups, persistThreadOrganization, threadDragItem]
  )

  const handleCreateAgent = useCallback(async () => {
    const api = getHandoffApi()
    if (!api) {
      showToast("Preload bridge unavailable", "error")
      return
    }

    try {
      const nextAgent = await api.agents.create()
      setAgents(currentAgents => [...currentAgents, nextAgent])
      setSelectedAgentId(nextAgent.id)
      setAgentsPaneView("agent")
      setIsEditingAgent(true)
      setAgentDraft(cloneAgentDefinition(nextAgent))
      setAgentEditorError(null)
      setActiveSection("agents")
      setIsSettingsOpen(false)
      showToast("Created agent")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to create agent.", "error")
    }
  }, [showToast])

  const handleSelectAgent = useCallback((agentId: string) => {
    setActiveSection("agents")
    setIsSettingsOpen(false)
    setSelectedAgentId(agentId)
    setAgentsPaneView("agent")
    setIsEditingAgent(false)
    setAgentEditorError(null)
  }, [])

  const handleOpenAgentsDashboard = useCallback(() => {
    setActiveSection("agents")
    setIsSettingsOpen(false)
    setAgentsPaneView("dashboard")
    setIsEditingAgent(false)
    setAgentEditorError(null)
  }, [])

  const handleOpenAgentAutomation = useCallback(() => {
    setActiveSection("agents")
    setIsSettingsOpen(false)
    setAgentsPaneView("automation")
    setIsEditingAgent(false)
  }, [])

  const handleStartAgentEdit = useCallback(() => {
    setAgentsPaneView("agent")
    setIsEditingAgent(true)
    setAgentEditorError(null)
  }, [])

  const handleCancelAgentEdit = useCallback(() => {
    setAgentDraft(cloneAgentDefinition(selectedAgent))
    setIsEditingAgent(false)
    setAgentEditorError(null)
  }, [selectedAgent])

  const handleToggleAgentRun = useCallback((_runId: string) => {
    return
  }, [])

  const handleCancelAgentRun = useCallback(
    async (runId: string) => {
      const api = getHandoffApi()
      if (!api) {
        showToast("The preload bridge did not load. Restart the app.", "error")
        return
      }

      try {
        const nextRun = await api.bridge.cancelRun(runId)
        if (!nextRun) {
          showToast("Run not found", "error")
          return
        }

        await loadAgentRuns()
        showToast("Canceled agent run")
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Unable to cancel run.", "error")
      }
    },
    [loadAgentRuns, showToast]
  )

  const handleAgentDraftChange = useCallback((patch: AgentUpdatePatch) => {
    setAgentDraft(currentDraft => {
      if (!currentDraft) {
        return currentDraft
      }

      const provider = patch.provider ?? currentDraft.provider
      const normalizedTarget = normalizeComposerTarget({
        provider,
        launchMode: "cli",
        modelId: patch.modelId ?? currentDraft.modelId,
        fast: patch.fast ?? currentDraft.fast
      })

      return {
        ...currentDraft,
        ...patch,
        provider,
        modelId: normalizedTarget.modelId,
        fast: normalizedTarget.fast
      }
    })
    setAgentEditorError(null)
  }, [])

  const handleSaveAgent = useCallback(async () => {
    if (!selectedAgentId || !agentDraft) {
      return
    }

    const trimmedName = agentDraft.name.trim()
    if (!trimmedName) {
      setAgentEditorError("Agent name is required.")
      return
    }

    const api = getHandoffApi()
    if (!api) {
      showToast("Preload bridge unavailable", "error")
      return
    }

    try {
      const updatedAgent = await api.agents.update(selectedAgentId, {
        name: trimmedName,
        specialty: agentDraft.specialty?.trim() ?? "",
        provider: agentDraft.provider,
        modelId: agentDraft.modelId,
        thinkingLevel: agentDraft.thinkingLevel,
        fast: agentDraft.fast,
        timeoutSec: agentDraft.timeoutSec,
        customInstructions: agentDraft.customInstructions
      })
      setAgents(currentAgents =>
        currentAgents.map(agent => (agent.id === updatedAgent.id ? updatedAgent : agent))
      )
      setAgentDraft(cloneAgentDefinition(updatedAgent))
      setIsEditingAgent(false)
      setAgentEditorError(null)
      showToast("Saved agent")
    } catch (error) {
      setAgentEditorError(error instanceof Error ? error.message : "Unable to save agent.")
      showToast(error instanceof Error ? error.message : "Unable to save agent.", "error")
    }
  }, [agentDraft, selectedAgentId, showToast])

  const handleResetAgent = useCallback(() => {
    setAgentDraft(cloneAgentDefinition(selectedAgent))
    setAgentEditorError(null)
  }, [selectedAgent])

  const handleDeleteAgent = useCallback(async () => {
    if (!selectedAgent) {
      return
    }

    if (!window.confirm(`Delete "${selectedAgent.name}"?`)) {
      return
    }

    const api = getHandoffApi()
    if (!api) {
      showToast("Preload bridge unavailable", "error")
      return
    }

    try {
      await api.agents.delete(selectedAgent.id)
      setAgents(currentAgents =>
        currentAgents.filter(agent => agent.id !== selectedAgent.id)
      )
      setSelectedAgentId(null)
      setAgentsPaneView("dashboard")
      setIsEditingAgent(false)
      setAgentEditorError(null)
      showToast("Deleted agent")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to delete agent.", "error")
    }
  }, [selectedAgent, showToast])

  const handleDuplicateAgent = useCallback(async () => {
    if (!selectedAgent) {
      return
    }

    const api = getHandoffApi()
    if (!api) {
      showToast("Preload bridge unavailable", "error")
      return
    }

    try {
      const duplicatedAgent = await api.agents.duplicate(selectedAgent.id)
      setAgents(currentAgents => [...currentAgents, duplicatedAgent])
      setSelectedAgentId(duplicatedAgent.id)
      setAgentsPaneView("agent")
      setIsEditingAgent(false)
      setAgentDraft(cloneAgentDefinition(duplicatedAgent))
      setAgentEditorError(null)
      showToast("Duplicated agent")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to duplicate agent.", "error")
    }
  }, [selectedAgent, showToast])

  const handleInstallSkills = useCallback(
    async (target: SkillInstallTarget) => {
      const api = getHandoffApi()
      if (!api) {
        showToast("Preload bridge unavailable", "error")
        return
      }

      setIsMutatingSkills(true)
      try {
        const nextSkillsStatus = await api.skills.install(target)
        setSkillsStatus(nextSkillsStatus)
        setSkillsError(null)
        showToast(
          target === "both"
            ? "Installed Handoff skills in Codex and Claude"
            : `Installed Handoff skill in ${formatProviderLabel(target)}`
        )
      } catch (error) {
        setSkillsError(error instanceof Error ? error.message : "Unable to install skills.")
        showToast(
          error instanceof Error ? error.message : "Unable to install skills.",
          "error"
        )
      } finally {
        setIsMutatingSkills(false)
      }
    },
    [showToast]
  )

  const handleExportSkillsPackage = useCallback(async () => {
    const api = getHandoffApi()
    if (!api) {
      showToast("Preload bridge unavailable", "error")
      return
    }

    setIsMutatingSkills(true)
    try {
      const result = await api.skills.exportPackage()
      showToast(`Exported skills package to ${result.exportPath}`)
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Unable to export skills package.",
        "error"
      )
    } finally {
      setIsMutatingSkills(false)
    }
  }, [showToast])

  const handleCopySkillSetupInstructions = useCallback(
    async (target: SkillInstallTarget) => {
      const api = getHandoffApi()
      if (!api) {
        showToast("Preload bridge unavailable", "error")
        return
      }

      try {
        await api.skills.copySetupInstructions(target)
        showToast("Copied setup instructions")
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "Unable to copy setup instructions.",
          "error"
        )
      }
    },
    [showToast]
  )

  const handleSidebarResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isSidebarCollapsed) {
        return
      }

      event.preventDefault()
      setSidebarDragState({
        startX: event.clientX,
        startWidth: resolvedSidebarWidth
      })
    },
    [isSidebarCollapsed, resolvedSidebarWidth]
  )

  function renderThreadSidebarList() {
    return (
      <div className="session-list" role="list">
        <div className="sidebar-filter-list-row sidebar-organizer-row">
          <button
            aria-label="Create collection"
            className="sidebar-filter-button sidebar-filter-list-icon-button"
            onClick={handleOpenCreateCollectionDialog}
            type="button"
          >
            <NewCollectionIcon />
          </button>

          <button
            aria-expanded={isFilterPopoverOpen}
            aria-haspopup="dialog"
            aria-label={isFilterPopoverOpen ? "Close filters" : "Open filters"}
            aria-pressed={hasActiveSidebarFilters}
            className={`sidebar-filter-button sidebar-filter-list-button ${
              hasActiveSidebarFilters ? "is-active" : ""
            }`}
            onClick={handleFilterPopoverToggle}
            ref={filterButtonRef}
            type="button"
          >
            <FilterIcon />
            <span className="sidebar-filter-button-label">Filter</span>
            {hasActiveSidebarFilters ? (
              <span aria-hidden="true" className="sidebar-filter-button-dot" />
            ) : null}
          </button>

          <ThreadOrganizeMenu
            onSortKeyChange={handleThreadSortKeyChange}
            onViewModeChange={handleThreadViewModeChange}
            sortKey={threadOrganization.sortKey}
            viewMode={threadOrganization.viewMode}
          />

          {isFilterPopoverOpen ? (
            <div
              aria-label="Session filters"
              className="sidebar-filter-popover"
              ref={filterPopoverRef}
              role="dialog"
            >
              <div className="sidebar-filter-popover-header">
                <span className="sidebar-filter-popover-title">Filters</span>
                <button
                  aria-label="Dismiss filter panel"
                  className="sidebar-filter-close-button"
                  onClick={() => setIsFilterPopoverOpen(false)}
                  type="button"
                >
                  ×
                </button>
              </div>
              <SidebarFilterContent
                filters={sidebarFilters}
                onArchivedChange={handleArchivedFilterChange}
                onDateChange={handleDateFilterChange}
                onProjectToggle={handleProjectFilterToggle}
                onProviderChange={handleProviderFilterChange}
                projectOptions={projectOptions}
              />
            </div>
          ) : null}
        </div>

        {threadOrganization.viewMode === "collection" ? (
          <div className="thread-collection-create-row">
            <button
              className="sidebar-filter-button sidebar-filter-list-button"
              onClick={handleOpenCreateCollectionDialog}
              type="button"
            >
              <NewCollectionIcon />
              <span className="sidebar-filter-button-label">New collection</span>
            </button>
          </div>
        ) : null}

        {isLoadingSessions && sessions.length === 0 ? (
          <EmptyState
            title="Loading sessions"
            detail="Reading Codex and Claude session indexes and resolving available conversation files."
          />
        ) : sessions.length === 0 ? (
          <EmptyState
            title="No sessions found"
            detail="No conversation entries were available from Codex or Claude."
          />
        ) : filteredSessions.length === 0 ? (
          <EmptyState
            title="No matching sessions"
            detail="No sessions match the current filters."
          />
        ) : threadOrganization.viewMode === "chronological" ? (
          sortedFilteredSessions.map(session => (
            <ThreadSessionRow
              isActive={session.id === activeSessionId && visibleSidebarSessionIds.has(session.id)}
              isGrouped={false}
              key={`${session.id}:${session.updatedAt}:${session.threadName}`}
              onSelect={() => handleSelectSessionFromSidebar(session.id)}
              session={session}
              stateInfo={stateInfo}
            />
          ))
        ) : (
          visibleThreadGroups.map(group => {
            const isProjectView = threadOrganization.viewMode === "project"
            const canCollapse = group.kind !== "system"
            const groupDropBefore =
              (isProjectView &&
                threadDropIndicator?.type === "project-group" &&
                threadDropIndicator.projectPath === group.projectPath &&
                threadDropIndicator.position === "before") ||
              (!isProjectView &&
                threadDropIndicator?.type === "collection-group" &&
                threadDropIndicator.collectionId === group.collectionId &&
                threadDropIndicator.position === "before")
            const groupDropAfter =
              (isProjectView &&
                threadDropIndicator?.type === "project-group" &&
                threadDropIndicator.projectPath === group.projectPath &&
                threadDropIndicator.position === "after") ||
              (!isProjectView &&
                threadDropIndicator?.type === "collection-group" &&
                threadDropIndicator.collectionId === group.collectionId &&
                threadDropIndicator.position === "after")
            const groupAppendIndicator =
              (isProjectView &&
                threadDropIndicator?.type === "project-append" &&
                threadDropIndicator.projectPath === group.projectPath) ||
              (!isProjectView &&
                threadDropIndicator?.type === "collection-append" &&
                threadDropIndicator.collectionId === group.collectionId)

            return (
              <div className="thread-group" key={group.id}>
                <div
                  className={`thread-group-header ${group.canReorder ? "is-draggable" : ""} ${
                    groupDropBefore ? "is-drop-before" : ""
                  } ${groupDropAfter ? "is-drop-after" : ""} ${
                    groupAppendIndicator ? "is-drop-append" : ""
                  }`}
                  draggable={group.canReorder}
                  onDragEnd={handleThreadDragEnd}
                  onDragOver={event => {
                    if (!threadDragItem) {
                      return
                    }

                    if (
                      (isProjectView &&
                        ((threadDragItem.type === "project-group" && group.projectPath) ||
                          (threadDragItem.type === "project-thread" &&
                            threadDragItem.projectPath === group.projectPath))) ||
                      (!isProjectView &&
                        ((threadDragItem.type === "collection-group" && group.collectionId) ||
                          threadDragItem.type === "collection-thread"))
                    ) {
                      event.preventDefault()
                      event.stopPropagation()
                      event.dataTransfer.dropEffect = "move"

                      if (isProjectView && group.projectPath) {
                        if (threadDragItem.type === "project-group") {
                          setThreadDropIndicator({
                            type: "project-group",
                            projectPath: group.projectPath,
                            position: getVerticalDropPosition(event)
                          })
                          return
                        }

                        setThreadDropIndicator({
                          type: "project-append",
                          projectPath: group.projectPath
                        })
                        return
                      }

                      if (!isProjectView) {
                        if (threadDragItem.type === "collection-group" && group.collectionId) {
                          setThreadDropIndicator({
                            type: "collection-group",
                            collectionId: group.collectionId,
                            position: getVerticalDropPosition(event)
                          })
                          return
                        }

                        setThreadDropIndicator({
                          type: "collection-append",
                          collectionId: group.collectionId
                        })
                      }
                    }
                  }}
                  onDragStart={event => {
                    if (!group.canReorder) {
                      return
                    }

                    event.dataTransfer.effectAllowed = "move"
                    event.dataTransfer.setData("text/plain", group.id)
                    setThreadDropIndicator(null)

                    if (isProjectView && group.projectPath) {
                      setThreadDragItem({
                        type: "project-group",
                        projectPath: group.projectPath
                      })
                    } else if (!isProjectView && group.collectionId) {
                      setThreadDragItem({
                        type: "collection-group",
                        collectionId: group.collectionId
                      })
                    }
                  }}
                  onDrop={event => {
                    event.preventDefault()
                    event.stopPropagation()

                    if (isProjectView && group.projectPath) {
                      if (threadDragItem?.type === "project-group") {
                        handleProjectGroupDrop(group.projectPath, event)
                        return
                      }

                      if (threadDragItem?.type === "project-thread") {
                        handleProjectThreadAppend(group.projectPath)
                      }
                      return
                    }

                    if (!isProjectView && group.collectionId) {
                      handleCollectionGroupDrop(group.collectionId, event)
                      return
                    }

                    if (!isProjectView && threadDragItem?.type === "collection-thread") {
                      handleCollectionThreadDrop(null, group.sessions[0]?.id ?? "", event)
                    }
                  }}
                >
                  <button
                    className="thread-group-header-main"
                    onClick={() => {
                      if (!canCollapse) {
                        return
                      }

                      if (isProjectView && group.projectPath) {
                        handleToggleProjectCollapsed(group.projectPath)
                        return
                      }

                      if (!isProjectView && group.collectionId) {
                        handleToggleCollectionCollapsed(group.collectionId)
                      }
                    }}
                    type="button"
                  >
                    <span className={`thread-group-chevron ${!group.collapsed ? "is-open" : ""}`}>
                      {canCollapse ? "›" : ""}
                    </span>
                    {isProjectView ? (
                      <span className="thread-group-leading-icon">
                        <FolderIcon />
                      </span>
                    ) : group.kind === "collection" ? (
                      <span
                        className="thread-group-leading-icon thread-group-leading-icon-collection"
                        style={
                          {
                            "--collection-color": resolveCollectionColor(group.collectionColor)
                          } as CSSProperties
                        }
                      >
                        <CollectionSymbol icon={group.collectionIcon} />
                      </span>
                    ) : (
                      <span className="thread-group-leading-icon">
                        <CollectionIcon />
                      </span>
                    )}
                    <span className="thread-group-title">{group.title}</span>
                  </button>

                  <div className="thread-group-header-actions">
                    {group.subtitle ? (
                      <span className="thread-group-subtitle" title={group.subtitle}>
                        {group.subtitle}
                      </span>
                    ) : null}
                    {group.canRename || group.canDelete ? (
                      <ThreadGroupMenuButton
                        canDelete={!isProjectView && group.collectionId !== null}
                        kind={isProjectView ? "project" : "collection"}
                        onDelete={
                          !isProjectView && group.collectionId
                            ? () => handleDeleteCollection(group.collectionId as string)
                            : undefined
                        }
                        onEditAppearance={
                          !isProjectView && group.collectionId
                            ? () => handleOpenCollectionAppearanceEditor(group.collectionId as string)
                            : undefined
                        }
                        onRename={() => {
                          if (group.projectPath) {
                            handleRenameProjectAlias(group.projectPath)
                            return
                          }

                          if (group.collectionId) {
                            handleRenameCollection(group.collectionId)
                          }
                        }}
                      />
                    ) : null}
                  </div>
                </div>

                {!group.collapsed ? (
                  <div
                    className={`thread-group-body ${groupAppendIndicator ? "is-drop-append" : ""}`}
                    onDragOver={event => {
                      if (!threadDragItem) {
                        return
                      }

                      if (
                        (isProjectView &&
                          threadDragItem.type === "project-thread" &&
                          threadDragItem.projectPath === group.projectPath) ||
                        (!isProjectView && threadDragItem.type === "collection-thread")
                      ) {
                        event.preventDefault()
                        event.stopPropagation()
                        event.dataTransfer.dropEffect = "move"

                        if (isProjectView && group.projectPath) {
                          setThreadDropIndicator({
                            type: "project-append",
                            projectPath: group.projectPath
                          })
                          return
                        }

                        setThreadDropIndicator({
                          type: "collection-append",
                          collectionId: group.collectionId
                        })
                      }
                    }}
                    onDrop={event => {
                      event.preventDefault()
                      event.stopPropagation()

                      if (isProjectView && group.projectPath) {
                        handleProjectThreadAppend(group.projectPath)
                        return
                      }

                      if (!isProjectView && group.collectionId) {
                        handleCollectionGroupDrop(group.collectionId, event)
                        return
                      }

                      if (!isProjectView && threadDragItem?.type === "collection-thread") {
                        handleCollectionThreadDrop(null, group.sessions[0]?.id ?? "", event)
                      }
                    }}
                  >
                    {group.sessions.map(session => {
                      const rowDropIndicator = isProjectView
                        ? threadDropIndicator?.type === "project-thread" &&
                          threadDropIndicator.projectPath === group.projectPath &&
                          threadDropIndicator.threadId === session.id
                          ? threadDropIndicator.position
                          : null
                        : threadDropIndicator?.type === "collection-thread" &&
                            threadDropIndicator.collectionId === group.collectionId &&
                            threadDropIndicator.threadId === session.id
                          ? threadDropIndicator.position
                          : null

                      return (
                        <ThreadSessionRow
                          draggable={
                            (isProjectView && group.projectPath !== null) ||
                            !isProjectView
                          }
                          dropIndicator={rowDropIndicator}
                          isActive={
                            session.id === activeSessionId &&
                            visibleSidebarSessionIds.has(session.id)
                          }
                          isGrouped={true}
                          key={`${group.id}:${session.id}:${session.updatedAt}`}
                          onDragEnd={handleThreadDragEnd}
                          onDragOver={event => {
                            if (!threadDragItem) {
                              return
                            }

                            const acceptsProjectThread =
                              isProjectView &&
                              threadDragItem.type === "project-thread" &&
                              threadDragItem.projectPath === group.projectPath
                            const acceptsCollectionThread =
                              !isProjectView && threadDragItem.type === "collection-thread"

                            if (acceptsProjectThread || acceptsCollectionThread) {
                              event.preventDefault()
                              event.stopPropagation()
                              event.dataTransfer.dropEffect = "move"

                              if (isProjectView && group.projectPath) {
                                setThreadDropIndicator({
                                  type: "project-thread",
                                  projectPath: group.projectPath,
                                  threadId: session.id,
                                  position: getVerticalDropPosition(event)
                                })
                                return
                              }

                              setThreadDropIndicator({
                                type: "collection-thread",
                                collectionId: group.collectionId,
                                threadId: session.id,
                                position: getVerticalDropPosition(event)
                              })
                            }
                          }}
                          onDragStart={event => {
                            event.dataTransfer.effectAllowed = "move"
                            event.dataTransfer.setData("text/plain", session.id)
                            setThreadDropIndicator(null)

                            if (isProjectView && group.projectPath) {
                              setThreadDragItem({
                                type: "project-thread",
                                projectPath: group.projectPath,
                                threadId: session.id
                              })
                              return
                            }

                            setThreadDragItem({
                              type: "collection-thread",
                              collectionId: group.collectionId,
                              threadId: session.id
                            })
                          }}
                          onDrop={event => {
                            event.preventDefault()
                            event.stopPropagation()

                            if (isProjectView && group.projectPath) {
                              handleProjectThreadDrop(group.projectPath, session.id, event)
                              return
                            }

                            handleCollectionThreadDrop(group.collectionId, session.id, event)
                          }}
                          onSelect={() => handleSelectSessionFromSidebar(session.id)}
                          session={session}
                          stateInfo={stateInfo}
                        />
                      )
                    })}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    )
  }

  return (
    <div className="app-shell">
      {isCreateCollectionDialogOpen ? (
        <CollectionCreateDialog
          inputRef={newCollectionInputRef}
          onCancel={handleCancelCreateCollection}
          onChange={setNewCollectionNameDraft}
          onSubmit={handleConfirmCreateCollection}
          value={newCollectionNameDraft}
        />
      ) : null}
      {editingCollectionAppearanceId ? (
        <CollectionAppearanceDialog
          color={collectionAppearanceDraft.color}
          icon={collectionAppearanceDraft.icon}
          onCancel={handleCloseCollectionAppearanceEditor}
          onColorSelect={color =>
            setCollectionAppearanceDraft(current => ({
              ...current,
              color
            }))
          }
          onIconSelect={icon =>
            setCollectionAppearanceDraft(current => ({
              ...current,
              icon
            }))
          }
          onSubmit={handleSaveCollectionAppearance}
        />
      ) : null}

      <div
        className={`workspace ${sidebarDragState ? "is-resizing" : ""} ${
          isSidebarCollapsed ? "is-sidebar-collapsed" : ""
        }`}
        style={workspaceStyle}
      >
        <section className="section-rail">
          <div className="section-rail-top">
            <button
              aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="sidebar-toggle-button section-rail-collapse-button"
              onClick={handleSidebarToggle}
              type="button"
            >
              <span
                aria-hidden="true"
                className={`sidebar-toggle-icon ${isSidebarCollapsed ? "is-collapsed" : ""}`}
              >
                <span className="sidebar-toggle-frame" />
                <span className="sidebar-toggle-divider" />
              </span>
            </button>

            <div className="section-rail-nav">
              <button
                aria-pressed={activeSection === "threads"}
                className={`section-rail-button ${activeSection === "threads" ? "is-active" : ""}`}
                onClick={() => handleSelectSection("threads")}
                type="button"
              >
                <ThreadsIcon />
                <span className="section-rail-label">Threads</span>
              </button>
              <button
                aria-pressed={activeSection === "agents"}
                className={`section-rail-button ${activeSection === "agents" ? "is-active" : ""}`}
                onClick={() => handleSelectSection("agents")}
                type="button"
              >
                <AgentsIcon />
                <span className="section-rail-label">Agents</span>
              </button>
              <button
                aria-pressed={activeSection === "selector"}
                className={`section-rail-button ${activeSection === "selector" ? "is-active" : ""}`}
                onClick={() => handleSelectSection("selector")}
                type="button"
              >
                <SelectorIcon />
                <span className="section-rail-label">Selector</span>
              </button>
            </div>
          </div>

          <div className="section-rail-footer">
            <button
              aria-label={isSettingsOpen ? "Back from settings" : "Open settings"}
              className={`section-rail-button section-rail-settings-button ${
                isSettingsOpen ? "is-active" : ""
              }`}
              onClick={isSettingsOpen ? handleCloseSettings : handleOpenSettings}
              title={isSettingsOpen ? "Back" : "Settings"}
              type="button"
            >
              {isSettingsOpen ? <BackArrowIcon /> : <SettingsIcon />}
              <span className="section-rail-label">{isSettingsOpen ? "Back" : "Settings"}</span>
            </button>
          </div>
        </section>

        <section className={`sidebar-pane ${isSidebarCollapsed ? "is-collapsed" : ""}`}>
          {!isSidebarCollapsed ? (
            <>
              {activeSection === "threads" ? (
                <>
                  <div className="sidebar-header">
                    <div className="sidebar-header-controls">
                      <button
                        aria-label="Open search"
                        aria-pressed={!isSettingsOpen && rightPaneMode === "search"}
                        className={`sidebar-filter-button ${
                          !isSettingsOpen && rightPaneMode === "search" ? "is-active" : ""
                        }`}
                        onClick={handleOpenSearch}
                        type="button"
                      >
                        <SearchIcon />
                        <span className="sidebar-filter-button-label">Search</span>
                      </button>

                      <button
                        aria-label="Open new thread"
                        aria-pressed={!isSettingsOpen && rightPaneMode === "new-thread"}
                        className={`sidebar-filter-button ${
                          !isSettingsOpen && rightPaneMode === "new-thread" ? "is-active" : ""
                        }`}
                        onClick={handleOpenNewThread}
                        type="button"
                      >
                        <WriteIcon />
                        <span className="sidebar-filter-button-label">New</span>
                      </button>
                    </div>
                  </div>

                  {renderThreadSidebarList()}
                </>
              ) : activeSection === "agents" ? (
                <AgentsListPane
                  agents={sortedAgents}
                  agentsError={agentsError}
                  isDashboardSelected={agentsPaneView === "dashboard"}
                  isLoading={isLoadingAgents}
                  onCreate={() => void handleCreateAgent()}
                  onSelectDashboard={handleOpenAgentsDashboard}
                  onSelect={handleSelectAgent}
                  selectedAgentId={selectedAgentId}
                  stateInfo={stateInfo}
                />
              ) : (
                <SelectorSidebarPane controller={selectorSection} />
              )}

              <div
                aria-hidden="true"
                className="sidebar-resizer"
                onPointerDown={handleSidebarResizeStart}
              />
            </>
          ) : null}

        </section>

        <section className="main-pane">
          {toastState ? (
            <div
              aria-live="polite"
              className={`top-toast is-${toastState.tone} ${
                toastState.visible ? "is-visible" : ""
              }`}
              role="status"
            >
              <span className="top-toast-message">{toastState.message}</span>
            </div>
          ) : null}

          <header className="topbar">
            <div className="topbar-left">
              {isSettingsOpen ? (
                <span className="topbar-thread">Settings</span>
              ) : activeSection === "agents" ? (
                agentsPaneView === "automation" ? (
                  <span className="topbar-thread">Automation / Skills</span>
                ) : agentsPaneView === "agent" && selectedAgent ? (
                  <>
                    <span className="topbar-thread">{selectedAgent.name}</span>
                    <div className="topbar-session-meta">
                      <ProviderIcon provider={selectedAgent.provider} stateInfo={stateInfo} />
                    </div>
                  </>
                ) : (
                  <span className="topbar-thread">Agents</span>
                )
              ) : activeSection === "selector" ? (
                <span className="topbar-thread">
                  {selectorSection.activeManifest?.name ?? "Selector"}
                </span>
              ) : rightPaneMode === "new-thread" ? (
                <span className="topbar-thread">New Thread</span>
              ) : rightPaneMode === "search" ? (
                <span className="topbar-thread">Search</span>
              ) : activeSession ? (
                <>
                  {activeSession.archived ? (
                    <span className="archived-indicator" title="Archived">
                      A
                    </span>
                  ) : null}
                  <span className="topbar-thread">{activeSession.threadName}</span>
                  <div className="topbar-session-meta">
                    <ProviderIcon provider={activeSession.provider} stateInfo={stateInfo} />
                    <span className="topbar-updated">
                      {formatTimestamp(activeSession.updatedAt)}
                    </span>
                    {activeTranscript?.hasDiffs ? (
                      <span className="topbar-badge">Diffs</span>
                    ) : null}
                  </div>
                </>
              ) : (
                <span className="topbar-thread">Handoff</span>
              )}
            </div>

            <div className="toolbar">
              {!isSettingsOpen && activeSection === "agents" && agentsPaneView === "automation" ? (
                <button
                  className="topbar-button"
                  onClick={handleOpenAgentsDashboard}
                  type="button"
                >
                  Back
                </button>
              ) : !isSettingsOpen && activeSection === "threads" && rightPaneMode === "new-thread" ? (
                <button
                  className="topbar-button"
                  onClick={handleCloseNewThread}
                  type="button"
                >
                  Cancel
                </button>
              ) : !isSettingsOpen &&
                activeSection === "threads" &&
                rightPaneMode === "conversation" &&
                searchReturnActive ? (
                <button
                  className="topbar-button"
                  onClick={handleReturnToSearch}
                  type="button"
                >
                  Back to results
                </button>
              ) : null}
              {!isSettingsOpen &&
              activeSection === "threads" &&
              rightPaneMode !== "new-thread" ? (
                <button
                  className="topbar-button"
                  onClick={() => {
                    const api = getHandoffApi()
                    if (!api) {
                      setListError("The preload bridge did not load. Restart the app.")
                      return
                    }

                    void api.app.refresh()
                  }}
                  type="button"
                >
                  Refresh
                </button>
              ) : !isSettingsOpen && activeSection === "selector" ? (
                <button
                  className="topbar-button"
                  onClick={() => {
                    void selectorSection.refresh()
                  }}
                  type="button"
                >
                  Refresh
                </button>
              ) : null}
            </div>
          </header>

          {activeSection === "threads" && listError ? (
            <div className="banner banner-error">{listError}</div>
          ) : activeSection === "selector" && selectorSection.errorMessage ? (
            <div className="banner banner-error">{selectorSection.errorMessage}</div>
          ) : null}

          <section className="detail-pane">
            <div className="transcript-surface">
              {isSettingsOpen ? (
                <SettingsPane
                  bridgeError={bridgeError}
                  bridgeSnippets={bridgeSnippets}
                  bridgeStatus={bridgeStatus}
                  onCopyBridgeSnippet={(label, value) => {
                    void copyTextValue(value, label)
                  }}
                  onDefaultTerminalSelect={handleDefaultTerminalSelect}
                  onProviderOverrideChange={handleProviderOverrideChange}
                  onProviderReset={handleProviderReset}
                  onTerminalToggle={handleTerminalToggle}
                  settingsError={settingsError}
                  settingsSnapshot={settingsSnapshot}
                />
              ) : activeSection === "agents" ? (
                isLoadingAgents && agents.length === 0 && agentsPaneView !== "dashboard" ? (
                  <EmptyState title="Loading agents" detail="Reading saved agent presets." />
                ) : agentsPaneView === "dashboard" ? (
                  <AgentDashboardPane
                    bridgeStatus={bridgeStatus}
                    isLoadingRuns={isLoadingAgentRuns}
                    onCancelRun={runId => {
                      void handleCancelAgentRun(runId)
                    }}
                    onOpenAutomation={handleOpenAgentAutomation}
                    onToggleRun={handleToggleAgentRun}
                    runs={agentRuns}
                    runsError={agentRunsError}
                    skillsError={skillsError}
                    skillsStatus={skillsStatus}
                  />
                ) : agentsPaneView === "automation" ? (
                  <AgentAutomationPane
                    isBusy={isMutatingSkills}
                    onCopySetupInstructions={target => {
                      void handleCopySkillSetupInstructions(target)
                    }}
                    onExportPackage={() => {
                      void handleExportSkillsPackage()
                    }}
                    onInstall={target => {
                      void handleInstallSkills(target)
                    }}
                    onToolTimeoutChange={handleSkillToolTimeoutChange}
                    skillTimeouts={{
                      codex: settingsSnapshot?.settings.skills?.codex?.toolTimeoutSec ?? null,
                      claude: settingsSnapshot?.settings.skills?.claude?.toolTimeoutSec ?? null
                    }}
                    skillsError={skillsError}
                    skillsStatus={skillsStatus}
                  />
                ) : agents.length === 0 ? (
                  <EmptyState title="No agents yet" detail="Create an agent from the left rail." />
                ) : (
                  <AgentDetailPane
                      agent={selectedAgent}
                      draft={agentDraft}
                      editorError={agentEditorError}
                      isEditing={isEditingAgent}
                      isLoadingRuns={isLoadingAgentRuns}
                      onCancelEdit={handleCancelAgentEdit}
                      onCancelRun={runId => {
                        void handleCancelAgentRun(runId)
                      }}
                      onDelete={() => void handleDeleteAgent()}
                      onDraftChange={handleAgentDraftChange}
                      onDuplicate={() => void handleDuplicateAgent()}
                      onEdit={handleStartAgentEdit}
                      onReset={handleResetAgent}
                      onSave={() => void handleSaveAgent()}
                      onToggleRun={handleToggleAgentRun}
                      runs={selectedAgentRuns}
                      runsError={agentRunsError}
                    />
                )
              ) : activeSection === "selector" ? (
                <SelectorDetailPane controller={selectorSection} />
              ) : rightPaneMode === "new-thread" ? (
                <NewThreadPane
                  draft={newThreadDraft}
                  generatedPrompt={generatedNewThreadPrompt}
                  isLoadingSourceTranscript={isLoadingNewThreadSource}
                  onCopyPrompt={() => void handleCopyNewThreadPrompt()}
                  onDraftChange={handleNewThreadDraftChange}
                  onProjectPathChange={projectPath =>
                    handleNewThreadDraftChange({ projectPath })
                  }
                  onSelectSourceSession={handleSelectNewThreadSource}
                  onSourceQueryChange={handleNewThreadSourceQueryChange}
                  onStartThread={() => void handleStartNewThread()}
                  projectOptions={newThreadProjectOptions}
                  projectPath={newThreadDraft.projectPath}
                  promptError={newThreadPromptError}
                  selectedSourceSession={selectedNewThreadSourceSession}
                  sourceError={newThreadSourceError}
                  sourceQuery={newThreadSourceQuery}
                  sourceResults={newThreadSourceResults}
                  stateInfo={stateInfo}
                />
              ) : rightPaneMode === "search" ? (
                <div className="search-layout">
                  <div className="search-input-row">
                    <label className="search-input-shell">
                      <SearchIcon />
                      <input
                        className="search-input"
                        onChange={event => setSearchQuery(event.target.value)}
                        placeholder="Search conversations"
                        ref={searchInputRef}
                        type="text"
                        value={searchQuery}
                      />
                    </label>
                    <span className={`search-status-pill is-${searchStatus?.state ?? "warming"}`}>
                      {searchStatus?.state === "ready"
                        ? "Ready"
                        : searchStatus?.state === "error"
                          ? "Unavailable"
                          : "Preparing"}
                    </span>
                  </div>

                  <SearchFilterBar
                    filters={searchFilters}
                    onArchivedChange={handleSearchArchivedFilterChange}
                    onDateChange={handleSearchDateFilterChange}
                    onProjectToggle={handleSearchProjectToggle}
                    onProviderChange={handleSearchProviderFilterChange}
                    projectOptions={searchProjectOptions}
                  />

                  <SearchResultsPane
                    isLoading={isSearchLoading}
                    onSelect={handleSelectSearchResult}
                    query={searchQuery}
                    results={searchResults}
                    searchStatus={searchStatus}
                    stateInfo={stateInfo}
                  />
                </div>
              ) : !activeSession ? (
                <EmptyState
                  title="No conversation selected"
                  detail="Pick a conversation from the left sidebar to inspect it."
                />
              ) : !activeSession.sessionPath ? (
                <EmptyState
                  title="Session file missing"
                  detail="This thread still exists in the index, but no matching session file could be resolved from `~/.codex/sessions` or `~/.claude/projects`."
                />
              ) : conversationError ? (
                <EmptyState
                  title="Unable to parse conversation"
                  detail={conversationError}
                />
              ) : isLoadingConversation && !activeTranscript ? (
                <EmptyState
                  title="Loading conversation"
                  detail="Reading and parsing the selected session file."
                />
              ) : activeTranscript ? (
                <div className="conversation-layout">
                  {activeProjectPath ? (
                    <div className="project-toolbar">
                      <div className="project-toolbar-path-group">
                        <span className="project-toolbar-label">Project</span>
                        <span className="project-toolbar-path" title={activeProjectPath}>
                          {activeProjectPath}
                        </span>
                      </div>

                      <div className="project-toolbar-actions">
                        <button
                          className="project-toolbar-button"
                          onClick={() => void handleOpenProjectPath("finder")}
                          type="button"
                        >
                          Finder
                        </button>
                        <button
                          className="project-toolbar-button"
                          onClick={() => void handleOpenProjectPath("terminal")}
                          type="button"
                        >
                          Terminal
                        </button>
                        <button
                          className="project-toolbar-button"
                          onClick={() => void handleOpenProjectPath("editor")}
                          type="button"
                        >
                          Editor
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="conversation-list">
                    {activeTranscript.entries.map(entry => {
                      if (entry.kind === "thought_chain") {
                        return (
                          <ThoughtChain
                            entry={entry}
                            expanded={expandedThoughtChainIds.has(entry.id)}
                            key={entry.id}
                            onToggle={() => toggleThoughtChainEntry(entry.id)}
                          />
                        )
                      }

                      if (entry.role === "user") {
                        return (
                          <div className="conversation-entry user-entry" key={entry.id}>
                            <div className="user-bubble">
                              <MarkdownBlock
                                className="message-markdown user-markdown"
                                markdown={entry.bodyMarkdown}
                              />
                            </div>
                          </div>
                        )
                      }

                      return <AssistantMessage entry={entry} key={entry.id} />
                    })}
                  </div>
                </div>
              ) : (
                <EmptyState
                  title="Conversation unavailable"
                  detail="The selected conversation could not be rendered."
                />
              )}
            </div>

          {!isSettingsOpen && activeSection === "threads" && rightPaneMode === "conversation" ? (
            <div className="copy-bar">
              <div className="copy-bar-inner">
                <div className="copy-bar-row">
                  <button
                    className="ghost-button codex-thread-button"
                    disabled={!activeSession?.id || activeTranscript?.id !== activeSession.id}
                    onClick={() => void handleOpenInSource()}
                    type="button"
                  >
                    {activeProvider && getProviderIconDataUrl(activeProvider, stateInfo) ? (
                      <img
                        alt=""
                        aria-hidden="true"
                        className="codex-thread-icon"
                        src={getProviderIconDataUrl(activeProvider, stateInfo) ?? undefined}
                      />
                    ) : (
                      <span aria-hidden="true" className="codex-thread-fallback">
                        {activeProvider === "claude" ? "Cl" : "Co"}
                      </span>
                    )}
                    <span>{activeProviderLabel ? `Open in ${activeProviderLabel}` : "Open"}</span>
                  </button>

                  <div className="copy-actions">
                    <div className="output-format-menu" ref={outputFormatMenuRef}>
                      <button
                        aria-expanded={isOutputFormatMenuOpen}
                        aria-haspopup="menu"
                        aria-label={`Output format: ${selectedOutputFormatOption.label}`}
                        className="ghost-button output-format-button"
                        onClick={() => {
                          setIsCopyMenuOpen(false)
                          setIsOutputFormatMenuOpen(current => !current)
                        }}
                        title={`Output format: ${selectedOutputFormatOption.label}`}
                        type="button"
                      >
                        <OutputFormatIcon
                          className="output-format-icon"
                          format={selectedOutputFormatOption.key}
                        />
                      </button>

                      {isOutputFormatMenuOpen ? (
                        <div
                          aria-label="Output format options"
                          className="output-format-dropdown"
                          role="menu"
                        >
                          {OUTPUT_FORMAT_OPTIONS.map(option => (
                            <button
                              aria-checked={selectedOutputFormat === option.key}
                              className={`output-format-option ${
                                selectedOutputFormat === option.key ? "is-selected" : ""
                              }`}
                              key={option.key}
                              onClick={() => {
                                setSelectedOutputFormat(option.key)
                                setIsOutputFormatMenuOpen(false)
                              }}
                              role="menuitemradio"
                              type="button"
                            >
                              <OutputFormatIcon
                                className="output-format-icon"
                                format={option.key}
                              />
                              <span>{option.label}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="copy-split-group" ref={copyMenuRef}>
                      <button
                        className="accent-button copy-split-main"
                        disabled={selectedCopyActionOption.disabled}
                        onClick={() => void selectedCopyActionOption.run()}
                        type="button"
                      >
                        <OutputFormatIcon
                          className="output-format-icon"
                          format={selectedOutputFormatOption.key}
                        />
                        <span>{selectedCopyActionOption.label}</span>
                      </button>
                      <button
                        aria-expanded={isCopyMenuOpen}
                        aria-haspopup="menu"
                        aria-label="Open copy options"
                        className="accent-button copy-split-toggle"
                        onClick={() => {
                          setIsOutputFormatMenuOpen(false)
                          setIsCopyMenuOpen(current => !current)
                        }}
                        type="button"
                      >
                        <CopyChevronIcon isOpen={isCopyMenuOpen} />
                      </button>

                      {isCopyMenuOpen ? (
                        <div
                          aria-label="Copy options"
                          className="copy-split-menu"
                          role="menu"
                        >
                          {alternateCopyActions.map(action => (
                            <button
                              className="copy-split-option"
                              disabled={action.disabled}
                              key={action.key}
                              onClick={() => {
                                setSelectedCopyAction(action.key)
                                setIsCopyMenuOpen(false)
                                void action.run()
                              }}
                              role="menuitem"
                              type="button"
                            >
                              {action.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            ) : null}
          </section>
          {!isSettingsOpen && activeSection === "selector" ? (
            <>
              <SelectorAddFilesModal controller={selectorSection} />
              <SelectorBundleDialog controller={selectorSection} />
            </>
          ) : null}
        </section>
      </div>
    </div>
  )
}
