import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
  AppStateInfo,
  AssistantMessageEntry,
  AssistantThoughtChainEntry,
  ConversationPatch,
  ConversationTranscript,
  HandoffApi,
  ProjectLocationTarget,
  SessionListItem,
  SessionProvider
} from "../shared/contracts"
import {
  detectCodeLanguage,
  parseApplyPatches,
  type ParsedPatchFile,
  type ParsedPatchLine
} from "../shared/patch"

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

const DEFAULT_SIDEBAR_WIDTH = 280
const MIN_SIDEBAR_WIDTH = 220
const COLLAPSED_SIDEBAR_WIDTH = 128
const SIDEBAR_WIDTH_STORAGE_KEY = "handoff.sidebar-width"
const SIDEBAR_COLLAPSED_STORAGE_KEY = "handoff.sidebar-collapsed"
type ArchivedFilterValue = "all" | "not-archived" | "archived"
type ProviderFilterValue = "all" | SessionProvider
type DateRangeFilterValue = "24h" | "3d" | "7d" | "30d" | "all"

interface SidebarFilters {
  archived: ArchivedFilterValue
  provider: ProviderFilterValue
  projectPaths: string[]
  dateRange: DateRangeFilterValue
}

interface ProjectFilterOption {
  path: string
  label: string
}

const DEFAULT_SIDEBAR_FILTERS: SidebarFilters = {
  archived: "not-archived",
  provider: "all",
  projectPaths: [],
  dateRange: "30d"
}

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

function clampSidebarWidth(value: number, viewportWidth: number) {
  const maxWidth = Math.max(COLLAPSED_SIDEBAR_WIDTH, Math.floor(viewportWidth * 0.4))
  const minWidth = Math.min(MIN_SIDEBAR_WIDTH, maxWidth)
  return Math.min(Math.max(Math.round(value), minWidth), maxWidth)
}

function getPathBasename(filePath: string) {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath
}

function formatProjectFilterLabel(projectPath: string) {
  return getPathBasename(projectPath) || projectPath
}

function isDefaultSidebarFilters(filters: SidebarFilters) {
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

function getHandoffApi(): HandoffApi | null {
  return typeof window !== "undefined" ? window.handoffApp ?? null : null
}

export default function App() {
  const [stateInfo, setStateInfo] = useState<AppStateInfo | null>(null)
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeTranscript, setActiveTranscript] =
    useState<ConversationTranscript | null>(null)
  const [isLoadingSessions, setIsLoadingSessions] = useState(true)
  const [isLoadingConversation, setIsLoadingConversation] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth
  )
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredSidebarWidth())
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() =>
    readStoredSidebarCollapsed()
  )
  const [sidebarFilters, setSidebarFilters] = useState<SidebarFilters>(
    DEFAULT_SIDEBAR_FILTERS
  )
  const [isFilterPopoverOpen, setIsFilterPopoverOpen] = useState(false)
  const [sidebarDragState, setSidebarDragState] = useState<{
    startX: number
    startWidth: number
  } | null>(null)
  const [expandedThoughtChainIds, setExpandedThoughtChainIds] = useState<Set<string>>(
    () => new Set()
  )
  const filterButtonRef = useRef<HTMLButtonElement | null>(null)
  const filterPopoverRef = useRef<HTMLDivElement | null>(null)
  const resolvedSidebarWidth = isSidebarCollapsed
    ? COLLAPSED_SIDEBAR_WIDTH
    : clampSidebarWidth(sidebarWidth, viewportWidth)
  const workspaceStyle = useMemo(
    () =>
      ({
        "--sidebar-width": `${resolvedSidebarWidth}px`
      }) as CSSProperties,
    [resolvedSidebarWidth]
  )

  const hasActiveSidebarFilters = useMemo(
    () => !isDefaultSidebarFilters(sidebarFilters),
    [sidebarFilters]
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
  const activeSession = useMemo(
    () => filteredSessions.find(session => session.id === activeSessionId) ?? null,
    [activeSessionId, filteredSessions]
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

  const copyMarkdown = useCallback(async (text: string, successLabel: string) => {
    const api = getHandoffApi()
    if (!api) {
      setCopyStatus("Preload bridge unavailable")
      return
    }

    await api.clipboard.writeText(text)
    setCopyStatus(successLabel)
    window.setTimeout(() => {
      setCopyStatus(current => (current === successLabel ? null : current))
    }, 2400)
  }, [])

  const handleCopyChat = useCallback(async () => {
    if (!activeSession) {
      return
    }

    const api = getHandoffApi()
    if (!api) {
      setCopyStatus("Preload bridge unavailable")
      return
    }

    const transcript = await api.sessions.getTranscript(activeSession.id, {
      includeCommentary: false,
      includeDiffs: false
    })
    await copyMarkdown(transcript.markdown, "Copied chat")
  }, [activeSession, copyMarkdown])

  const handleCopyChatWithDiffs = useCallback(async () => {
    if (!activeTranscript?.markdown) {
      return
    }

    await copyMarkdown(activeTranscript.markdown, "Copied chat + diffs")
  }, [activeTranscript, copyMarkdown])

  const handleCopyLastMessage = useCallback(async () => {
    if (!activeTranscript?.lastAssistantMarkdown) {
      return
    }

    await copyMarkdown(activeTranscript.lastAssistantMarkdown, "Copied last message")
  }, [activeTranscript, copyMarkdown])

  const handleOpenInSource = useCallback(async () => {
    if (!activeSession?.id || activeTranscript?.id !== activeSession.id) {
      return
    }

    const api = getHandoffApi()
    if (!api) {
      setCopyStatus("Preload bridge unavailable")
      return
    }

    try {
      const providerLabel = formatProviderLabel(activeTranscript.provider)

      await api.app.openSourceSession(
        activeTranscript.provider,
        activeTranscript.sourceSessionId,
        activeTranscript.sessionClient,
        activeTranscript.projectPath ?? activeTranscript.sessionCwd
      )
      setCopyStatus(`Opened in ${providerLabel}`)
      window.setTimeout(() => {
        setCopyStatus(current =>
          current === `Opened in ${providerLabel}` ? null : current
        )
      }, 2400)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Unable to open ${formatProviderLabel(activeTranscript.provider)}`
      setCopyStatus(message)
    }
  }, [activeSession, activeTranscript])

  const handleOpenProjectPath = useCallback(
    async (target: ProjectLocationTarget) => {
      if (!activeProjectPath) {
        return
      }

      const api = getHandoffApi()
      if (!api) {
        setCopyStatus("Preload bridge unavailable")
        return
      }

      const targetLabel = formatProjectLocationLabel(target)

      try {
        await api.app.openProjectPath(target, activeProjectPath)
        setCopyStatus(`Opened in ${targetLabel}`)
        window.setTimeout(() => {
          setCopyStatus(current =>
            current === `Opened in ${targetLabel}` ? null : current
          )
        }, 2400)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `Unable to open ${targetLabel}`
        setCopyStatus(message)
      }
    },
    [activeProjectPath]
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
      await loadSessions()
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
  }, [loadSessions])

  useEffect(() => {
    void loadConversation(activeSession)
  }, [activeSession, loadConversation])

  useEffect(() => {
    setExpandedThoughtChainIds(new Set())
  }, [activeTranscript?.id, activeTranscript?.updatedAt])

  useEffect(() => {
    if (filteredSessions.length === 0) {
      if (activeSessionId !== null) {
        setActiveSessionId(null)
      }
      return
    }

    if (!activeSessionId || !filteredSessions.some(session => session.id === activeSessionId)) {
      setActiveSessionId(filteredSessions[0]?.id ?? null)
    }
  }, [activeSessionId, filteredSessions])

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

  return (
    <div className="app-shell">
      <div
        className={`workspace ${sidebarDragState ? "is-resizing" : ""}`}
        style={workspaceStyle}
      >
        <section
          className={`sidebar-pane ${isSidebarCollapsed ? "is-collapsed" : ""}`}
        >
          <div className="sidebar-header">
            <div className="sidebar-header-controls">
              <button
                aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                className="sidebar-toggle-button"
                onClick={handleSidebarToggle}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={`sidebar-toggle-icon ${
                    isSidebarCollapsed ? "is-collapsed" : ""
                  }`}
                >
                  <span className="sidebar-toggle-frame" />
                  <span className="sidebar-toggle-divider" />
                </span>
              </button>

              <button
                aria-expanded={isFilterPopoverOpen}
                aria-haspopup="dialog"
                aria-label={isFilterPopoverOpen ? "Close filters" : "Open filters"}
                aria-pressed={hasActiveSidebarFilters}
                className={`sidebar-filter-button ${
                  hasActiveSidebarFilters ? "is-active" : ""
                }`}
                onClick={handleFilterPopoverToggle}
                ref={filterButtonRef}
                type="button"
              >
                <FilterIcon />
                {!isSidebarCollapsed ? (
                  <span className="sidebar-filter-button-label">Filter</span>
                ) : null}
                {hasActiveSidebarFilters ? (
                  <span aria-hidden="true" className="sidebar-filter-button-dot" />
                ) : null}
              </button>
            </div>
          </div>

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

              <div className="sidebar-filter-section">
                <p className="sidebar-filter-section-label">Archived</p>
                <div className="sidebar-filter-option-group">
                  {ARCHIVED_FILTER_OPTIONS.map(option => (
                    <button
                      aria-label={`Archived: ${option.label}`}
                      className={`sidebar-filter-option-button ${
                        sidebarFilters.archived === option.value ? "is-selected" : ""
                      }`}
                      key={option.value}
                      onClick={() => handleArchivedFilterChange(option.value)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sidebar-filter-section">
                <p className="sidebar-filter-section-label">Provider</p>
                <div className="sidebar-filter-option-group">
                  {PROVIDER_FILTER_OPTIONS.map(option => (
                    <button
                      aria-label={`Provider: ${option.label}`}
                      className={`sidebar-filter-option-button ${
                        sidebarFilters.provider === option.value ? "is-selected" : ""
                      }`}
                      key={option.value}
                      onClick={() => handleProviderFilterChange(option.value)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sidebar-filter-section">
                <p className="sidebar-filter-section-label">Project</p>
                {projectOptions.length === 0 ? (
                  <p className="sidebar-filter-empty">No projects available.</p>
                ) : (
                  <div className="sidebar-filter-project-list">
                    {projectOptions.map(option => (
                      <label
                        className="sidebar-filter-project-option"
                        key={option.path}
                        title={option.path}
                      >
                        <input
                          checked={sidebarFilters.projectPaths.includes(option.path)}
                          onChange={() => handleProjectFilterToggle(option.path)}
                          type="checkbox"
                        />
                        <span className="sidebar-filter-project-copy">
                          <span className="sidebar-filter-project-name">{option.label}</span>
                          <span className="sidebar-filter-project-path">{option.path}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="sidebar-filter-section">
                <p className="sidebar-filter-section-label">Date</p>
                <div className="sidebar-filter-option-group">
                  {DATE_FILTER_OPTIONS.map(option => (
                    <button
                      aria-label={`Date: ${option.label}`}
                      className={`sidebar-filter-option-button ${
                        sidebarFilters.dateRange === option.value ? "is-selected" : ""
                      }`}
                      key={option.value}
                      onClick={() => handleDateFilterChange(option.value)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {!isSidebarCollapsed ? (
            <div className="session-list" role="list">
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
                ) : (
                filteredSessions.map(session => (
                  <button
                    key={`${session.id}:${session.updatedAt}:${session.threadName}`}
                    className={`session-row ${
                      session.id === activeSessionId ? "is-active" : ""
                    }`}
                    onClick={() => setActiveSessionId(session.id)}
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
                ))
              )}
            </div>
          ) : (
            <div className="sidebar-collapsed-spacer" />
          )}

          {!isSidebarCollapsed ? (
            <div
              aria-hidden="true"
              className="sidebar-resizer"
              onPointerDown={handleSidebarResizeStart}
            />
          ) : null}
        </section>

        <section className="main-pane">
          <header className="topbar">
            <div className="topbar-left">
              {activeSession ? (
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
            </div>
          </header>

          {listError ? (
            <div className="banner banner-error">{listError}</div>
          ) : null}

          <section className="detail-pane">
          <div className="transcript-surface">
            {!activeSession ? (
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

          <div className="copy-bar">
            <div className="copy-bar-inner">
              <div className="copy-status">{copyStatus ?? " "}</div>
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
                  <button
                    className="ghost-button"
                    disabled={!activeSession?.sessionPath}
                    onClick={() => void handleCopyChat()}
                    type="button"
                  >
                    Copy Chat
                  </button>
                  <button
                    className="accent-button"
                    disabled={!activeTranscript?.markdown}
                    onClick={() => void handleCopyChatWithDiffs()}
                    type="button"
                  >
                    Copy Chat + Diffs
                  </button>
                  <button
                    className="ghost-button"
                    disabled={!activeTranscript?.lastAssistantMarkdown}
                    onClick={() => void handleCopyLastMessage()}
                    type="button"
                  >
                    Copy Last Message
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
        </section>
      </div>
    </div>
  )
}
