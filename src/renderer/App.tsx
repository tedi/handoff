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
  ThreadLaunchMode,
  ThreadLaunchVendor
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
  isLoading,
  onCreate,
  onSelect,
  selectedAgentId,
  stateInfo
}: {
  agents: AgentDefinition[]
  agentsError: string | null
  isLoading: boolean
  onCreate(): void
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
            className={`session-row ${agent.id === selectedAgentId ? "is-active" : ""}`}
            key={agent.id}
            onClick={() => onSelect(agent.id)}
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
            <span className="session-subtitle">
              {getComposerModelLabel(agent.provider, agent.modelId)}
            </span>
          </button>
        ))
      )}
    </div>
  )
}

function AgentEditorPane({
  agent,
  draft,
  editorError,
  onDraftChange,
  onDuplicate,
  onDelete,
  onReset,
  onSave
}: {
  agent: AgentDefinition | null
  draft: AgentDefinition | null
  editorError: string | null
  onDraftChange(patch: AgentUpdatePatch): void
  onDuplicate(): void
  onDelete(): void
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
          <h2>{draft.name}</h2>
          <p>Save reusable provider, model, and instruction defaults for later use.</p>
        </div>
        <div className="agent-editor-header-actions">
          <button className="ghost-button" onClick={onDuplicate} type="button">
            Duplicate
          </button>
          <button className="ghost-button" onClick={onDelete} type="button">
            Delete
          </button>
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
  agent,
  runs,
  selectedRunId,
  isLoading,
  runsError,
  onSelectRun,
  onCancelRun
}: {
  agent: AgentDefinition | null
  runs: AgentRunRecord[]
  selectedRunId: string | null
  isLoading: boolean
  runsError: string | null
  onSelectRun(runId: string): void
  onCancelRun(runId: string): void
}) {
  if (!agent) {
    return null
  }

  const selectedRun =
    runs.find(run => run.runId === selectedRunId) ?? runs[0] ?? null

  return (
    <section className="settings-card">
      <div className="settings-card-copy">
        <h2>Agent runs</h2>
        <p>Persisted MCP bridge requests and responses for this agent.</p>
      </div>

      {runsError ? <div className="new-thread-inline-error">{runsError}</div> : null}

      {isLoading && runs.length === 0 ? (
        <p className="agent-run-empty">Loading run history.</p>
      ) : runs.length === 0 ? (
        <p className="agent-run-empty">No bridge runs recorded for this agent yet.</p>
      ) : (
        <div className="agent-run-layout">
          <div className="agent-run-list" role="list">
            {runs.map(run => (
              <button
                className={`agent-run-row ${run.runId === selectedRun?.runId ? "is-active" : ""}`}
                key={run.runId}
                onClick={() => onSelectRun(run.runId)}
                type="button"
              >
                <div className="agent-run-row-header">
                  <span className={`agent-run-status is-${run.status}`}>
                    {formatAgentRunStatus(run.status)}
                  </span>
                  <span className="agent-run-time">{formatTimestamp(run.startedAt)}</span>
                </div>
                <div className="agent-run-row-meta">
                  <span>{getComposerModelLabel(run.provider, run.modelId)}</span>
                  <span>{run.projectPath}</span>
                </div>
              </button>
            ))}
          </div>

          {selectedRun ? (
            <div className="agent-run-detail">
              <div className="settings-card-inline-actions">
                {selectedRun.status === "running" ? (
                  <button
                    className="ghost-button"
                    onClick={() => onCancelRun(selectedRun.runId)}
                    type="button"
                  >
                    Cancel run
                  </button>
                ) : null}
              </div>

              <div className="settings-meta-grid">
                <div className="settings-meta-item">
                  <span className="settings-meta-label">Status</span>
                  <SettingsValue value={formatAgentRunStatus(selectedRun.status)} />
                </div>
                <div className="settings-meta-item">
                  <span className="settings-meta-label">Started</span>
                  <SettingsValue value={formatTimestamp(selectedRun.startedAt)} />
                </div>
                <div className="settings-meta-item">
                  <span className="settings-meta-label">Model</span>
                  <SettingsValue
                    value={getComposerModelLabel(selectedRun.provider, selectedRun.modelId)}
                  />
                </div>
                <div className="settings-meta-item">
                  <span className="settings-meta-label">Thinking</span>
                  <SettingsValue
                    value={
                      THINKING_LEVEL_OPTIONS.find(
                        option => option.value === selectedRun.thinkingLevel
                      )?.label ?? selectedRun.thinkingLevel
                    }
                  />
                </div>
                <div className="settings-meta-item settings-meta-item-wide">
                  <span className="settings-meta-label">Project</span>
                  <SettingsValue monospace value={selectedRun.projectPath} />
                </div>
                <div className="settings-meta-item settings-meta-item-wide">
                  <span className="settings-meta-label">Run ID</span>
                  <SettingsValue monospace value={selectedRun.runId} />
                </div>
                {selectedRun.finishedAt ? (
                  <div className="settings-meta-item">
                    <span className="settings-meta-label">Finished</span>
                    <SettingsValue value={formatTimestamp(selectedRun.finishedAt)} />
                  </div>
                ) : null}
              </div>

              <div className="agent-run-body">
                <div className="settings-field">
                  <span className="settings-field-label">Request</span>
                  <textarea
                    className="settings-input agent-run-textarea"
                    readOnly
                    spellCheck={false}
                    value={selectedRun.message}
                  />
                </div>

                {selectedRun.context ? (
                  <div className="settings-field">
                    <span className="settings-field-label">Context</span>
                    <textarea
                      className="settings-input agent-run-textarea"
                      readOnly
                      spellCheck={false}
                      value={selectedRun.context}
                    />
                  </div>
                ) : null}

                <div className="settings-field">
                  <span className="settings-field-label">
                    {selectedRun.status === "completed" ? "Response" : "Error"}
                  </span>
                  <textarea
                    className="settings-input agent-run-textarea"
                    readOnly
                    spellCheck={false}
                    value={
                      selectedRun.status === "completed"
                        ? selectedRun.answer ?? ""
                        : selectedRun.error ?? ""
                    }
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

function AgentAutomationPane({
  agent,
  skillsStatus,
  skillsError,
  skillTimeouts,
  isBusy,
  onInstall,
  onExportPackage,
  onCopySetupInstructions,
  onToolTimeoutChange
}: {
  agent: AgentDefinition | null
  skillsStatus: HandoffSkillsStatus | null
  skillsError: string | null
  skillTimeouts: Record<SessionProvider, number | null>
  isBusy: boolean
  onInstall(target: SkillInstallTarget): void
  onExportPackage(): void
  onCopySetupInstructions(target: SkillInstallTarget): void
  onToolTimeoutChange(provider: SessionProvider, timeoutSec: number | null): void
}) {
  if (!agent) {
    return null
  }

  return (
    <section className="settings-card">
      <div className="settings-card-copy">
        <h2>Automation / Skills</h2>
        <p>
          Install the generic Handoff bridge skill for Codex and Claude Code. The
          installed skill starts async bridge jobs, polls for completion, and routes by
          exact agent name first, then specialty.
        </p>
      </div>

      <div className="settings-meta-grid">
        <div className="settings-meta-item">
          <span className="settings-meta-label">Agent name match</span>
          <SettingsValue value={agent.name} />
        </div>
        <div className="settings-meta-item settings-meta-item-wide">
          <span className="settings-meta-label">Specialty</span>
          <SettingsValue
            value={agent.specialty?.trim() ? agent.specialty : "Not set"}
          />
        </div>
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
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [agentDraft, setAgentDraft] = useState<AgentDefinition | null>(null)
  const [agentEditorError, setAgentEditorError] = useState<string | null>(null)
  const [agentRuns, setAgentRuns] = useState<AgentRunRecord[]>([])
  const [selectedAgentRunId, setSelectedAgentRunId] = useState<string | null>(null)
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

        return nextAgents[0]?.id ?? null
      })
    } catch (error) {
      setAgents([])
      setAgentsError(error instanceof Error ? error.message : "Unable to load agents.")
      setSelectedAgentId(null)
    } finally {
      setIsLoadingAgents(false)
    }
  }, [])

  const loadAgentRuns = useCallback(async (agentId: string | null) => {
    if (!agentId) {
      setAgentRuns([])
      setSelectedAgentRunId(null)
      setAgentRunsError(null)
      setIsLoadingAgentRuns(false)
      return
    }

    setIsLoadingAgentRuns(true)
    const api = getHandoffApi()

    if (!api) {
      setAgentRuns([])
      setSelectedAgentRunId(null)
      setAgentRunsError("The preload bridge did not load. Restart the app.")
      setIsLoadingAgentRuns(false)
      return
    }

    try {
      const nextRuns = sortAgentRunsByStartedAt(await api.bridge.listRuns(agentId, 50))
      setAgentRuns(nextRuns)
      setAgentRunsError(null)
      setSelectedAgentRunId(currentSelectedRunId => {
        if (currentSelectedRunId && nextRuns.some(run => run.runId === currentSelectedRunId)) {
          return currentSelectedRunId
        }

        return nextRuns[0]?.runId ?? null
      })
    } catch (error) {
      setAgentRuns([])
      setSelectedAgentRunId(null)
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
      await Promise.all([loadSessions(), loadAgents(), loadBridgeInfo(), loadSkillsStatus()])
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
  }, [loadAgents, loadBridgeInfo, loadSessions, loadSkillsStatus])

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

    void loadAgentRuns(selectedAgentId)
  }, [activeSection, isSettingsOpen, loadAgentRuns, selectedAgentId])

  useEffect(() => {
    if (activeSection !== "agents" || isSettingsOpen || !selectedAgentId) {
      return () => undefined
    }

    if (!agentRuns.some(run => run.status === "running")) {
      return () => undefined
    }

    const intervalId = window.setInterval(() => {
      void loadAgentRuns(selectedAgentId)
    }, 4_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [activeSection, agentRuns, isSettingsOpen, loadAgentRuns, selectedAgentId])

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
      return
    }

    if (!selectedAgentId || !agents.some(agent => agent.id === selectedAgentId)) {
      setSelectedAgentId(sortAgentsByName(agents)[0]?.id ?? null)
    }
  }, [agents, selectedAgentId])

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
    setAgentEditorError(null)
  }, [])

  const handleSelectAgentRun = useCallback((runId: string) => {
    setSelectedAgentRunId(runId)
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

        await loadAgentRuns(nextRun.agentId)
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

  return (
    <div className="app-shell">
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

                  <div className="session-list" role="list">
                    <div className="sidebar-filter-list-row">
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
                            filteredSessions.some(
                              visibleSession => visibleSession.id === activeSessionId
                            )
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
                </>
              ) : activeSection === "agents" ? (
                <AgentsListPane
                  agents={sortedAgents}
                  agentsError={agentsError}
                  isLoading={isLoadingAgents}
                  onCreate={() => void handleCreateAgent()}
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
                selectedAgent ? (
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
              {!isSettingsOpen && activeSection === "threads" && rightPaneMode === "new-thread" ? (
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
                isLoadingAgents && agents.length === 0 ? (
                  <EmptyState
                    title="Loading agents"
                    detail="Reading saved agent presets."
                  />
                ) : agents.length === 0 ? (
                  <EmptyState
                    title="No agents yet"
                    detail="Create an agent from the left rail to get started."
                  />
                ) : (
                  <div className="settings-layout">
                    <AgentEditorPane
                      agent={selectedAgent}
                      draft={agentDraft}
                      editorError={agentEditorError}
                      onDelete={() => void handleDeleteAgent()}
                      onDraftChange={handleAgentDraftChange}
                      onDuplicate={() => void handleDuplicateAgent()}
                      onReset={handleResetAgent}
                      onSave={() => void handleSaveAgent()}
                    />
                    <AgentAutomationPane
                      agent={selectedAgent}
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
                    <AgentRunsPane
                      agent={selectedAgent}
                      isLoading={isLoadingAgentRuns}
                      onCancelRun={runId => {
                        void handleCancelAgentRun(runId)
                      }}
                      onSelectRun={handleSelectAgentRun}
                      runs={agentRuns}
                      runsError={agentRunsError}
                      selectedRunId={selectedAgentRunId}
                    />
                  </div>
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
