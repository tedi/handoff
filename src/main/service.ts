import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import chokidar from "chokidar"

import { buildConversationTranscript } from "../shared/parser"
import type {
  AppStateInfo,
  ConversationTranscript,
  HandoffStateChangeEvent,
  HandoffStateChangeReason,
  SessionIndexEntry,
  SessionListItem,
  SessionProvider,
  TranscriptOptions
} from "../shared/contracts"

const SESSION_FILENAME_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const CLAUDE_HIDDEN_USER_PREFIXES = [
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<system-reminder>"
]

export interface HandoffServiceOptions {
  appDir?: string
  codexHome?: string
  claudeHome?: string
}

export interface HandoffService {
  app: {
    getStateInfo(): Promise<AppStateInfo>
    refresh(): Promise<HandoffStateChangeEvent>
  }
  sessions: {
    list(): Promise<SessionListItem[]>
    getTranscript(
      id: string,
      options: TranscriptOptions
    ): Promise<ConversationTranscript>
  }
  startWatching(): Promise<void>
  onStateChanged(listener: (event: HandoffStateChangeEvent) => void): () => void
  dispose(): Promise<void>
}

interface CacheState {
  entries: SessionIndexEntry[]
  byId: Map<string, SessionIndexEntry>
  pathById: Map<string, string>
}

interface SessionLocation {
  path: string
  archived: boolean
}

interface ClaudeSessionFileMetadata {
  sourceSessionId: string | null
  firstUserText: string | null
  updatedAt: string | null
  projectPath: string | null
  isSidechain: boolean
  shouldIgnore: boolean
}

function createSessionKey(provider: SessionProvider, sessionId: string) {
  return `${provider}:${sessionId}`
}

function fileExists(filePath: string) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false)
}

function truncateTitle(value: string, maxLength = 160) {
  const trimmed = value.replace(/\s+/g, " ").trim()
  if (!trimmed) {
    return ""
  }

  if (trimmed.length <= maxLength) {
    return trimmed
  }

  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`
}

function dedupeSessionEntries(entries: SessionIndexEntry[]) {
  const latestById = new Map<string, SessionIndexEntry>()

  for (const entry of entries) {
    const current = latestById.get(entry.id)
    if (!current || entry.updatedAt.localeCompare(current.updatedAt) > 0) {
      latestById.set(entry.id, entry)
    }
  }

  return [...latestById.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  )
}

async function walkSessionFiles(rootDir: string): Promise<string[]> {
  const queue = [rootDir]
  const result: string[] = []

  while (queue.length > 0) {
    const currentDir = queue.shift()!
    let entries
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue
      }

      throw error
    }

    for (const entry of entries) {
      const nextPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        queue.push(nextPath)
        continue
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(nextPath)
      }
    }
  }

  return result
}

async function buildCodexSessionLocationMap(params: {
  sessionsRoot: string
  archivedSessionsRoot: string
}) {
  const [activeFiles, archivedFiles] = await Promise.all([
    walkSessionFiles(params.sessionsRoot),
    walkSessionFiles(params.archivedSessionsRoot)
  ])
  const locationsById = new Map<string, SessionLocation>()

  for (const filePath of activeFiles) {
    const match = filePath.match(SESSION_FILENAME_PATTERN)
    const sessionId = match?.[1]
    if (!sessionId) {
      continue
    }

    locationsById.set(createSessionKey("codex", sessionId), {
      path: filePath,
      archived: false
    })
  }

  for (const filePath of archivedFiles) {
    const match = filePath.match(SESSION_FILENAME_PATTERN)
    const sessionId = match?.[1]
    if (!sessionId) {
      continue
    }

    const key = createSessionKey("codex", sessionId)
    if (locationsById.has(key)) {
      continue
    }

    locationsById.set(key, {
      path: filePath,
      archived: true
    })
  }

  return locationsById
}

function parseCodexIndexLine(line: string, lineNumber: number): SessionIndexEntry {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid session index JSON on line ${lineNumber}: ${message}`)
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    typeof (parsed as { thread_name?: unknown }).thread_name !== "string" ||
    typeof (parsed as { updated_at?: unknown }).updated_at !== "string"
  ) {
    throw new Error(`Invalid session index record on line ${lineNumber}.`)
  }

  const sourceSessionId = (parsed as { id: string }).id

  return {
    id: createSessionKey("codex", sourceSessionId),
    sourceSessionId,
    provider: "codex",
    archived: false,
    threadName: (parsed as { thread_name: string }).thread_name,
    updatedAt: (parsed as { updated_at: string }).updated_at,
    projectPath: null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function extractClaudeTextFromMessage(message: Record<string, unknown>) {
  const content = message.content

  if (typeof content === "string") {
    const trimmed = content.trim()
    return CLAUDE_HIDDEN_USER_PREFIXES.some(prefix => trimmed.startsWith(prefix))
      ? ""
      : trimmed
  }

  if (!Array.isArray(content)) {
    return ""
  }

  const parts: string[] = []
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
      continue
    }

    const trimmed = item.text.trim()
    if (!trimmed) {
      continue
    }

    if (CLAUDE_HIDDEN_USER_PREFIXES.some(prefix => trimmed.startsWith(prefix))) {
      continue
    }

    parts.push(trimmed)
  }

  return parts.join("\n\n").trim()
}

function hasClaudeImageContent(message: Record<string, unknown>) {
  const content = message.content
  return Array.isArray(content)
    ? content.some(item => isRecord(item) && item.type === "image")
    : false
}

function isClaudeMistakeUserMessage(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  return (
    lines.length > 0 &&
    lines.every(line => line.startsWith("Unknown skill:"))
  )
}

async function readClaudeSessionFileMetadata(
  sessionPath: string
): Promise<ClaudeSessionFileMetadata> {
  let content = ""
  try {
    content = await fs.readFile(sessionPath, "utf8")
  } catch {
    return {
      sourceSessionId: null,
      firstUserText: null,
      updatedAt: null,
      projectPath: null,
      isSidechain: false,
      shouldIgnore: false
    }
  }

  let sourceSessionId: string | null = null
  let firstUserText: string | null = null
  let updatedAt: string | null = null
  let projectPath: string | null = null
  let isSidechain = false
  let hasVisibleAssistantFinal = false
  let hasMeaningfulUserInput = false
  let hasUserImageContent = false
  let hasVisibleUserText = false

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (!sourceSessionId && typeof record.sessionId === "string") {
      sourceSessionId = record.sessionId
    }

    if (!updatedAt && typeof record.timestamp === "string") {
      updatedAt = record.timestamp
    } else if (
      typeof record.timestamp === "string" &&
      updatedAt !== null &&
      record.timestamp > updatedAt
    ) {
      updatedAt = record.timestamp
    }

    if (!projectPath && typeof record.cwd === "string" && record.cwd.trim()) {
      projectPath = record.cwd
    }

    if (record.isSidechain === true) {
      isSidechain = true
    }

    if (record.type === "assistant" && isRecord(record.message)) {
      const stopReason =
        typeof record.message.stop_reason === "string"
          ? record.message.stop_reason
          : null
      const assistantText = extractClaudeTextFromMessage(record.message)

      if (stopReason === "end_turn" && assistantText) {
        hasVisibleAssistantFinal = true
      }
    }

    if (
      record.type === "user" &&
      record.isMeta !== true &&
      !isRecord(record.toolUseResult) &&
      isRecord(record.message)
    ) {
      if (hasClaudeImageContent(record.message)) {
        hasUserImageContent = true
      }

      const text = extractClaudeTextFromMessage(record.message)
      if (text) {
        hasVisibleUserText = true
        if (!firstUserText) {
          firstUserText = text
        }
        if (!isClaudeMistakeUserMessage(text)) {
          hasMeaningfulUserInput = true
        }
      }
    }
  }

  const shouldIgnore =
    !hasVisibleAssistantFinal &&
    !hasMeaningfulUserInput &&
    !hasUserImageContent &&
    (hasVisibleUserText || !firstUserText)

  return {
    sourceSessionId,
    firstUserText,
    updatedAt,
    projectPath,
    isSidechain,
    shouldIgnore
  }
}

function resolveClaudeThreadName(params: {
  summary?: unknown
  firstPrompt?: unknown
  fileMetadata?: ClaudeSessionFileMetadata | null
}) {
  const summary = typeof params.summary === "string" ? truncateTitle(params.summary) : ""
  if (summary) {
    return summary
  }

  const firstPrompt =
    typeof params.firstPrompt === "string" ? truncateTitle(params.firstPrompt) : ""
  if (firstPrompt && firstPrompt !== "No prompt") {
    return firstPrompt
  }

  const fallbackPrompt = truncateTitle(params.fileMetadata?.firstUserText ?? "")
  if (fallbackPrompt) {
    return fallbackPrompt
  }

  return "Claude conversation"
}

async function loadCodexEntries(params: {
  indexPath: string
  sessionsRoot: string
  archivedSessionsRoot: string
}) {
  const indexText = await fs.readFile(params.indexPath, "utf8")
  const locationsById = await buildCodexSessionLocationMap({
    sessionsRoot: params.sessionsRoot,
    archivedSessionsRoot: params.archivedSessionsRoot
  })
  const rawEntries = indexText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => parseCodexIndexLine(line, index + 1))
    .filter(entry => locationsById.has(entry.id))
    .map(entry => ({
      ...entry,
      archived: locationsById.get(entry.id)?.archived ?? false
    }))

  return {
    entries: dedupeSessionEntries(rawEntries),
    pathById: new Map(
      [...locationsById.entries()].map(([key, location]) => [key, location.path])
    )
  }
}

async function loadClaudeIndexEntries(projectDir: string, indexPath: string) {
  const parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
    entries?: unknown
  }
  const indexEntries = Array.isArray(parsed.entries) ? parsed.entries : []
  const entries: SessionIndexEntry[] = []
  const pathById = new Map<string, string>()

  for (const rawEntry of indexEntries) {
    if (!isRecord(rawEntry) || rawEntry.isSidechain === true) {
      continue
    }

    const sourceSessionId =
      typeof rawEntry.sessionId === "string" ? rawEntry.sessionId : null
    if (!sourceSessionId) {
      continue
    }

    const preferredPath =
      typeof rawEntry.fullPath === "string"
        ? rawEntry.fullPath
        : path.join(projectDir, `${sourceSessionId}.jsonl`)

    const sessionPathExists = await fileExists(preferredPath)
    const shouldInspectFileMetadata =
      !sessionPathExists ||
      typeof rawEntry.modified !== "string" ||
      typeof rawEntry.projectPath !== "string" ||
      typeof rawEntry.summary !== "string" ||
      rawEntry.summary.trim() === "" ||
      typeof rawEntry.firstPrompt !== "string" ||
      rawEntry.firstPrompt === "No prompt" ||
      isClaudeMistakeUserMessage(rawEntry.firstPrompt)
    const fileMetadata =
      shouldInspectFileMetadata
        ? await readClaudeSessionFileMetadata(preferredPath)
        : null

    if (fileMetadata?.isSidechain || fileMetadata?.shouldIgnore) {
      continue
    }

    const stat = sessionPathExists ? await fs.stat(preferredPath) : null
    const updatedAt =
      typeof rawEntry.modified === "string"
        ? rawEntry.modified
        : fileMetadata?.updatedAt ?? stat?.mtime.toISOString() ?? new Date(0).toISOString()

    const sessionId = createSessionKey("claude", sourceSessionId)
    const sessionPath = sessionPathExists ? preferredPath : null
    if (sessionPath) {
      pathById.set(sessionId, sessionPath)
    }

    entries.push({
      id: sessionId,
      sourceSessionId,
      provider: "claude",
      archived: false,
      threadName: resolveClaudeThreadName({
        summary: rawEntry.summary,
        firstPrompt: rawEntry.firstPrompt,
        fileMetadata
      }),
      updatedAt,
      projectPath:
        typeof rawEntry.projectPath === "string"
          ? rawEntry.projectPath
          : fileMetadata?.projectPath ?? null
    })
  }

  return { entries, pathById }
}

async function loadClaudeFallbackEntries(projectDir: string) {
  const dirEntries = await fs.readdir(projectDir, { withFileTypes: true })
  const entries: SessionIndexEntry[] = []
  const pathById = new Map<string, string>()

  for (const entry of dirEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue
    }

    const sessionPath = path.join(projectDir, entry.name)
    const metadata = await readClaudeSessionFileMetadata(sessionPath)
    if (metadata.isSidechain || metadata.shouldIgnore) {
      continue
    }

    const sourceSessionId =
      metadata.sourceSessionId ?? entry.name.match(SESSION_FILENAME_PATTERN)?.[1] ?? entry.name.replace(/\.jsonl$/i, "")

    const stat = await fs.stat(sessionPath)
    const id = createSessionKey("claude", sourceSessionId)
    pathById.set(id, sessionPath)
    entries.push({
      id,
      sourceSessionId,
      provider: "claude",
      archived: false,
      threadName: resolveClaudeThreadName({ fileMetadata: metadata }),
      updatedAt: metadata.updatedAt ?? stat.mtime.toISOString(),
      projectPath: metadata.projectPath
    })
  }

  return { entries, pathById }
}

async function loadClaudeEntries(claudeProjectsRoot: string) {
  const rootEntries = await fs.readdir(claudeProjectsRoot, { withFileTypes: true })
  const entries: SessionIndexEntry[] = []
  const pathById = new Map<string, string>()

  for (const rootEntry of rootEntries) {
    if (!rootEntry.isDirectory()) {
      continue
    }

    const projectDir = path.join(claudeProjectsRoot, rootEntry.name)
    const indexPath = path.join(projectDir, "sessions-index.json")
    const { entries: nextEntries, pathById: nextPathById } = (await fileExists(indexPath))
      ? await loadClaudeIndexEntries(projectDir, indexPath)
      : await loadClaudeFallbackEntries(projectDir)

    nextEntries.forEach(entry => entries.push(entry))
    nextPathById.forEach((value, key) => {
      pathById.set(key, value)
    })
  }

  return {
    entries: dedupeSessionEntries(entries),
    pathById
  }
}

export function createHandoffService(
  options: HandoffServiceOptions = {}
): HandoffService {
  const appDir = options.appDir ?? process.cwd()
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex")
  const claudeHome = options.claudeHome ?? path.join(os.homedir(), ".claude")
  const indexPath = path.join(codexHome, "session_index.jsonl")
  const sessionsRoot = path.join(codexHome, "sessions")
  const archivedSessionsRoot = path.join(codexHome, "archived_sessions")
  const claudeProjectsRoot = path.join(claudeHome, "projects")
  const outputDir = path.join(appDir, "output")
  const events = new EventEmitter()
  const normalizedIndexPath = indexPath.replaceAll("\\", "/")
  const normalizedArchivedSessionsRoot = archivedSessionsRoot.replaceAll("\\", "/")
  const normalizedClaudeProjectsRoot = claudeProjectsRoot.replaceAll("\\", "/")

  let cache: CacheState | null = null
  let listWatcher: ReturnType<typeof chokidar.watch> | null = null
  let selectedSessionWatcher: ReturnType<typeof chokidar.watch> | null = null
  let selectedSessionPath: string | null = null
  let emitTimer: NodeJS.Timeout | null = null
  let pendingEvent: {
    reason: HandoffStateChangeReason
    changedPath: string | null
  } | null = null

  function buildStateInfo(): AppStateInfo {
    return {
      indexPath,
      sessionsRoot,
      claudeProjectsRoot,
      outputDir
    }
  }

  function emitStateChanged(
    reason: HandoffStateChangeReason,
    changedPath: string | null = null
  ) {
    const event: HandoffStateChangeEvent = {
      at: new Date().toISOString(),
      reason,
      changedPath
    }

    events.emit("state-changed", event)
    return event
  }

  function scheduleStateChanged(
    reason: HandoffStateChangeReason,
    changedPath: string | null
  ) {
    pendingEvent = { reason, changedPath }

    if (emitTimer) {
      clearTimeout(emitTimer)
    }

    emitTimer = setTimeout(() => {
      const nextEvent = pendingEvent
      emitTimer = null
      pendingEvent = null

      if (!nextEvent) {
        return
      }

      emitStateChanged(nextEvent.reason, nextEvent.changedPath)
    }, 80)
  }

  async function loadCache() {
    const [{ entries: codexEntries, pathById: codexPathById }, { entries: claudeEntries, pathById: claudePathById }] =
      await Promise.all([
        loadCodexEntries({ indexPath, sessionsRoot, archivedSessionsRoot }),
        loadClaudeEntries(claudeProjectsRoot).catch(error => {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return { entries: [] as SessionIndexEntry[], pathById: new Map<string, string>() }
          }

          throw error
        })
      ])

    const entries = dedupeSessionEntries([...codexEntries, ...claudeEntries])
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    const pathById = new Map<string, string>()
    codexPathById.forEach((value, key) => {
      pathById.set(key, value)
    })
    claudePathById.forEach((value, key) => {
      pathById.set(key, value)
    })

    cache = {
      entries,
      byId,
      pathById
    }

    return cache
  }

  async function getCache() {
    return cache ?? loadCache()
  }

  async function watchSelectedSession(nextPath: string | null) {
    if (selectedSessionPath === nextPath) {
      return
    }

    if (selectedSessionWatcher) {
      await selectedSessionWatcher.close()
      selectedSessionWatcher = null
    }

    selectedSessionPath = nextPath
    if (!nextPath) {
      return
    }

    selectedSessionWatcher = chokidar.watch(nextPath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 25
      }
    })

    selectedSessionWatcher.on("all", () => {
      scheduleStateChanged("selected-session-changed", nextPath)
    })
  }

  return {
    app: {
      async getStateInfo() {
        return buildStateInfo()
      },

      async refresh() {
        await loadCache()
        return emitStateChanged("manual-refresh")
      }
    },

    sessions: {
      async list() {
        const nextCache = await loadCache()
        return nextCache.entries.map(entry => ({
          ...entry,
          sessionPath: nextCache.pathById.get(entry.id) ?? null
        }))
      },

      async getTranscript(id, options) {
        const nextCache = await getCache()
        const session = nextCache.byId.get(id)
        if (!session) {
          throw new Error(`Unknown session "${id}".`)
        }

        const sessionPath = nextCache.pathById.get(id) ?? null
        if (!sessionPath) {
          await watchSelectedSession(null)
          throw new Error(`Session file not found for "${session.threadName}".`)
        }

        const sessionContent = await fs.readFile(sessionPath, "utf8")
        const transcript = buildConversationTranscript({
          session,
          sessionContent,
          sessionPath,
          options
        })

        await watchSelectedSession(sessionPath)
        return transcript
      }
    },

    async startWatching() {
      if (listWatcher) {
        return
      }

      await loadCache()

      listWatcher = chokidar.watch([indexPath, claudeProjectsRoot, archivedSessionsRoot], {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 25
        },
        ignored: watchedPath => {
          const normalizedPath = watchedPath.replaceAll("\\", "/")

          if (
            normalizedPath === normalizedIndexPath ||
            normalizedPath === normalizedArchivedSessionsRoot ||
            normalizedPath === normalizedClaudeProjectsRoot
          ) {
            return false
          }

          if (
            normalizedPath.includes("/subagents/") ||
            normalizedPath.includes("/tool-results/")
          ) {
            return true
          }

          return (
            !normalizedPath.endsWith("/sessions-index.json") &&
            !normalizedPath.endsWith(".jsonl")
          )
        }
      })

      listWatcher.on("all", async (_eventName, changedPath) => {
        cache = null
        scheduleStateChanged("index-changed", changedPath ?? null)
      })
    },

    onStateChanged(listener) {
      events.on("state-changed", listener)
      return () => {
        events.off("state-changed", listener)
      }
    },

    async dispose() {
      if (emitTimer) {
        clearTimeout(emitTimer)
        emitTimer = null
      }

      events.removeAllListeners()

      if (selectedSessionWatcher) {
        await selectedSessionWatcher.close()
        selectedSessionWatcher = null
      }

      if (listWatcher) {
        await listWatcher.close()
        listWatcher = null
      }
    }
  }
}
