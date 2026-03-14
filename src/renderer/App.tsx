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
  ArchivedFilterValue,
  AppStateInfo,
  AssistantMessageEntry,
  AssistantThoughtChainEntry,
  ConversationPatch,
  ConversationTranscript,
  DateRangeFilterValue,
  HandoffApi,
  HandoffSettingsPatch,
  HandoffSettingsSnapshot,
  ProjectLocationTarget,
  ProviderLaunchOverrides,
  ProviderSettingsInfo,
  ProviderFilterValue,
  SearchFilters,
  SearchResult,
  SearchStatus,
  SessionListItem,
  SessionProvider,
  TerminalAppId,
  TerminalOption
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

const DEFAULT_SIDEBAR_WIDTH = 280
const MIN_SIDEBAR_WIDTH = 220
const COLLAPSED_SIDEBAR_WIDTH = 128
const SIDEBAR_WIDTH_STORAGE_KEY = "handoff.sidebar-width"
const SIDEBAR_COLLAPSED_STORAGE_KEY = "handoff.sidebar-collapsed"

interface ProjectFilterOption {
  path: string
  label: string
}

type FilterMenuKey = "archived" | "provider" | "project" | "date"
type CopyActionKey = "chat" | "chat-with-diffs" | "last-message"
type OutputFormatKey = "markdown" | "json" | "structured"

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

function applySettingsPatchToSnapshot(
  snapshot: HandoffSettingsSnapshot,
  patch: HandoffSettingsPatch
) {
  return {
    ...snapshot,
    settings: {
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
      terminals: {
        ...snapshot.settings.terminals,
        ...(patch.terminals ?? {})
      }
    }
  }
}

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

function escapeStructuredValue(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
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

function SettingsPane({
  settingsSnapshot,
  settingsError,
  onProviderOverrideChange,
  onProviderReset,
  onTerminalToggle,
  onDefaultTerminalSelect
}: {
  settingsSnapshot: HandoffSettingsSnapshot | null
  settingsError: string | null
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
    </div>
  )
}

function getHandoffApi(): HandoffApi | null {
  return typeof window !== "undefined" ? window.handoffApp ?? null : null
}

export default function App() {
  const [rightPaneMode, setRightPaneMode] = useState<
    "conversation" | "search" | "settings"
  >(
    "conversation"
  )
  const [previousPaneMode, setPreviousPaneMode] = useState<"conversation" | "search">(
    "conversation"
  )
  const [stateInfo, setStateInfo] = useState<AppStateInfo | null>(null)
  const [settingsSnapshot, setSettingsSnapshot] = useState<HandoffSettingsSnapshot | null>(
    null
  )
  const [settingsError, setSettingsError] = useState<string | null>(null)
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
  const [searchFilters, setSearchFilters] = useState<SearchFilters>(
    DEFAULT_SEARCH_FILTERS
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchStatus, setSearchStatus] = useState<SearchStatus | null>(null)
  const [isSearchLoading, setIsSearchLoading] = useState(false)
  const [searchReturnActive, setSearchReturnActive] = useState(false)
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
  const [expandedThoughtChainIds, setExpandedThoughtChainIds] = useState<Set<string>>(
    () => new Set()
  )
  const filterButtonRef = useRef<HTMLButtonElement | null>(null)
  const filterPopoverRef = useRef<HTMLDivElement | null>(null)
  const outputFormatMenuRef = useRef<HTMLDivElement | null>(null)
  const copyMenuRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchRequestIdRef = useRef(0)
  const settingsMutationQueueRef = useRef(Promise.resolve())
  const toastSequenceRef = useRef(0)
  const toastHideTimerRef = useRef<number | null>(null)
  const toastClearTimerRef = useRef<number | null>(null)
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
  const activeProjectPath =
    activeTranscript && activeTranscript.id === activeSession?.id
      ? activeTranscript.projectPath ?? activeTranscript.sessionCwd ?? null
      : null
  const activeProvider =
    activeTranscript && activeTranscript.id === activeSession?.id
      ? activeTranscript.provider
      : activeSession?.provider ?? null
  const activeProviderLabel = activeProvider ? formatProviderLabel(activeProvider) : null

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
        })
        .catch(async error => {
          showToast(
            error instanceof Error ? error.message : "Unable to update settings.",
            "error"
          )
          await loadSettingsSnapshot()
        })
    },
    [loadSettingsSnapshot, showToast]
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
        })
        .catch(async error => {
          showToast(
            error instanceof Error ? error.message : "Unable to reset settings.",
            "error"
          )
          await loadSettingsSnapshot()
        })
    },
    [loadSettingsSnapshot, showToast]
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
    if (rightPaneMode !== "search") {
      return
    }

    searchInputRef.current?.focus()
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
    })
  }, [rightPaneMode])

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
    if (rightPaneMode !== "search") {
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
  }, [rightPaneMode, searchFilters, searchQuery, searchStatus?.indexedAt, sessions.length])

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
  }, [activeSessionId, rightPaneMode])

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
    setRightPaneMode("search")
  }, [])

  const handleOpenSettings = useCallback(() => {
    if (rightPaneMode !== "settings") {
      setPreviousPaneMode(rightPaneMode)
    }
    setRightPaneMode("settings")
  }, [rightPaneMode])

  const handleCloseSettings = useCallback(() => {
    setRightPaneMode(previousPaneMode)
  }, [previousPaneMode])

  const handleReturnToSearch = useCallback(() => {
    setRightPaneMode("search")
  }, [])

  const handleSelectSessionFromSidebar = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    setRightPaneMode("conversation")
    setSearchReturnActive(false)
  }, [])

  const handleSelectSearchResult = useCallback((result: SearchResult) => {
    setActiveSessionId(result.id)
    setRightPaneMode("conversation")
    setSearchReturnActive(true)
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
                aria-label="Open search"
                aria-pressed={rightPaneMode === "search"}
                className={`sidebar-filter-button ${
                  rightPaneMode === "search" ? "is-active" : ""
                }`}
                onClick={handleOpenSearch}
                type="button"
              >
                <SearchIcon />
                {!isSidebarCollapsed ? (
                  <span className="sidebar-filter-button-label">Search</span>
                ) : null}
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
                      session.id === activeSessionId &&
                      filteredSessions.some(visibleSession => visibleSession.id === activeSessionId)
                        ? "is-active"
                        : ""
                    }`}
                    onClick={() => handleSelectSessionFromSidebar(session.id)}
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

          <div className="sidebar-footer">
            <button
              aria-label={rightPaneMode === "settings" ? "Back from settings" : "Open settings"}
              className={`sidebar-footer-button ${
                rightPaneMode === "settings" ? "is-active" : ""
              }`}
              onClick={rightPaneMode === "settings" ? handleCloseSettings : handleOpenSettings}
              title={rightPaneMode === "settings" ? "Back" : "Settings"}
              type="button"
            >
              {rightPaneMode === "settings" ? <BackArrowIcon /> : <SettingsIcon />}
              {!isSidebarCollapsed ? (
                <span className="sidebar-footer-button-label">
                  {rightPaneMode === "settings" ? "Back" : "Settings"}
                </span>
              ) : null}
            </button>
          </div>

          {!isSidebarCollapsed ? (
            <div
              aria-hidden="true"
              className="sidebar-resizer"
              onPointerDown={handleSidebarResizeStart}
            />
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
              {rightPaneMode === "settings" ? (
                <span className="topbar-thread">Settings</span>
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
              {rightPaneMode === "conversation" && searchReturnActive ? (
                <button
                  className="topbar-button"
                  onClick={handleReturnToSearch}
                  type="button"
                >
                  Back to results
                </button>
              ) : null}
              {rightPaneMode !== "settings" ? (
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
              ) : null}
            </div>
          </header>

          {listError ? (
            <div className="banner banner-error">{listError}</div>
          ) : null}

          <section className="detail-pane">
              <div className="transcript-surface">
            {rightPaneMode === "settings" ? (
              <SettingsPane
                onDefaultTerminalSelect={handleDefaultTerminalSelect}
                onProviderOverrideChange={handleProviderOverrideChange}
                onProviderReset={handleProviderReset}
                onTerminalToggle={handleTerminalToggle}
                settingsError={settingsError}
                settingsSnapshot={settingsSnapshot}
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

          {rightPaneMode === "conversation" ? (
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
        </section>
      </div>
    </div>
  )
}
