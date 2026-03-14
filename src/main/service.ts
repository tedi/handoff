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
  TranscriptOptions
} from "../shared/contracts"

const SESSION_FILENAME_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export interface HandoffServiceOptions {
  appDir?: string
  codexHome?: string
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

async function buildSessionPathMap(sessionsRoot: string) {
  const files = await walkSessionFiles(sessionsRoot)
  const pathById = new Map<string, string>()

  for (const filePath of files) {
    const match = filePath.match(SESSION_FILENAME_PATTERN)
    const sessionId = match?.[1]
    if (!sessionId) {
      continue
    }

    pathById.set(sessionId, filePath)
  }

  return pathById
}

function parseIndexLine(line: string, lineNumber: number): SessionIndexEntry {
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

  return {
    id: (parsed as { id: string }).id,
    threadName: (parsed as { thread_name: string }).thread_name,
    updatedAt: (parsed as { updated_at: string }).updated_at
  }
}

export function createHandoffService(
  options: HandoffServiceOptions = {}
): HandoffService {
  const appDir = options.appDir ?? process.cwd()
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex")
  const indexPath = path.join(codexHome, "session_index.jsonl")
  const sessionsRoot = path.join(codexHome, "sessions")
  const outputDir = path.join(appDir, "output")
  const events = new EventEmitter()

  let cache: CacheState | null = null
  let indexWatcher: ReturnType<typeof chokidar.watch> | null = null
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
    const indexText = await fs.readFile(indexPath, "utf8")
    const rawEntries = indexText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((line, index) => parseIndexLine(line, index + 1))
    const entries = dedupeSessionEntries(rawEntries)

    const byId = new Map(entries.map(entry => [entry.id, entry]))
    const pathById = await buildSessionPathMap(sessionsRoot)

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
      if (indexWatcher) {
        return
      }

      await loadCache()

      indexWatcher = chokidar.watch(indexPath, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 25
        }
      })

      indexWatcher.on("all", async () => {
        cache = null
        scheduleStateChanged("index-changed", indexPath)
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

      if (indexWatcher) {
        await indexWatcher.close()
        indexWatcher = null
      }
    }
  }
}
