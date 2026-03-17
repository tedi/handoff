import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import path from "node:path"

import type {
  AssistantMessageEntry,
  AssistantThoughtChainEntry,
  ConversationEntry,
  SearchFilters,
  SearchResult,
  SearchStatus,
  SessionListItem
} from "../shared/contracts"
import { buildConversationTranscript } from "../shared/parser"

const SEARCH_MODEL_ID = "Xenova/all-MiniLM-L6-v2"
const SEARCH_INDEX_VERSION = 1
const QUERY_CACHE_LIMIT = 40

interface SearchDocument {
  id: string
  sourceSessionId: string
  provider: SessionListItem["provider"]
  archived: boolean
  threadName: string
  createdAt: string
  updatedAt: string
  projectPath: string | null
  sessionPath: string
  signature: string
  markdownPath: string
  previewText: string
  firstUserMessage: string | null
  searchableText: string
  embedding: number[] | null
}

interface PersistedSearchIndex {
  version: number
  indexedAt: string | null
  documents: SearchDocument[]
}

export interface SearchEmbedder {
  embed(text: string): Promise<number[]>
  dispose?(): Promise<void> | void
}

export interface HandoffSearchService {
  getStatus(): Promise<SearchStatus>
  query(params: {
    query: string
    filters: SearchFilters
    limit: number
  }): Promise<SearchResult[]>
  syncSessions(sessions: SessionListItem[]): Promise<void>
  onStatusChanged(listener: (status: SearchStatus) => void): () => void
  dispose(): Promise<void>
}

export interface HandoffSearchServiceOptions {
  dataDir: string
  embedder?: SearchEmbedder
}

function isAssistantMessageEntry(entry: ConversationEntry): entry is AssistantMessageEntry {
  return entry.kind === "message" && entry.role === "assistant"
}

function isThoughtChainEntry(entry: ConversationEntry): entry is AssistantThoughtChainEntry {
  return entry.kind === "thought_chain"
}

function getPathBasename(filePath: string) {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function stripMarkdown(value: string) {
  return normalizeWhitespace(
    value
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^>\s?/gm, "")
  )
}

function matchesArchivedFilter(
  session: Pick<SearchDocument, "archived">,
  archivedFilter: SearchFilters["archived"]
) {
  if (archivedFilter === "all") {
    return true
  }

  return archivedFilter === "archived" ? session.archived : !session.archived
}

function matchesProviderFilter(
  session: Pick<SearchDocument, "provider">,
  providerFilter: SearchFilters["provider"]
) {
  return providerFilter === "all" ? true : session.provider === providerFilter
}

function matchesDateFilter(
  session: Pick<SearchDocument, "updatedAt">,
  dateFilter: SearchFilters["dateRange"],
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

function applySearchFilters(documents: SearchDocument[], filters: SearchFilters) {
  const now = Date.now()
  const filtered = documents.filter(
    document =>
      matchesDateFilter(document, filters.dateRange, now) &&
      matchesArchivedFilter(document, filters.archived) &&
      matchesProviderFilter(document, filters.provider)
  )

  if (filters.projectPaths.length === 0) {
    return filtered
  }

  const selectedProjectPaths = new Set(filters.projectPaths)
  return filtered.filter(
    document =>
      document.projectPath !== null && selectedProjectPaths.has(document.projectPath)
  )
}

function buildLexicalScore(document: SearchDocument, query: string) {
  const normalizedQuery = query.toLowerCase().trim()
  if (!normalizedQuery) {
    return 0
  }

  const terms = normalizedQuery.split(/\s+/).filter(Boolean)
  const title = document.threadName.toLowerCase()
  const firstUser = (document.firstUserMessage ?? "").toLowerCase()
  const body = document.searchableText.toLowerCase()

  let score = 0
  for (const term of terms) {
    if (title.includes(term)) {
      score += 18
      if (title.startsWith(term)) {
        score += 8
      }
    }

    if (firstUser.includes(term)) {
      score += 6
    }

    if (body.includes(term)) {
      score += 2
    }
  }

  return score
}

function buildSnippet(document: SearchDocument, query: string) {
  if (!query.trim()) {
    return document.previewText
  }

  const body = document.searchableText
  const normalizedBody = body.toLowerCase()
  const normalizedQuery = query.toLowerCase().trim()
  const matchIndex = normalizedBody.indexOf(normalizedQuery)

  if (matchIndex === -1) {
    return document.previewText
  }

  const snippetStart = Math.max(matchIndex - 80, 0)
  const snippetEnd = Math.min(matchIndex + normalizedQuery.length + 120, body.length)
  const prefix = snippetStart > 0 ? "…" : ""
  const suffix = snippetEnd < body.length ? "…" : ""
  return `${prefix}${body.slice(snippetStart, snippetEnd).trim()}${suffix}`
}

function dotProduct(left: number[], right: number[]) {
  const length = Math.min(left.length, right.length)
  let total = 0
  for (let index = 0; index < length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0)
  }
  return total
}

function formatSearchDocumentMarkdown(params: {
  threadName: string
  firstUserMessage: string | null
  entries: ConversationEntry[]
}) {
  const parts = [`# ${params.threadName}`, params.threadName]

  if (params.firstUserMessage) {
    parts.push(params.firstUserMessage)
  }

  for (const entry of params.entries) {
    if (entry.role === "user" && entry.kind === "message") {
      parts.push(entry.bodyMarkdown)
      continue
    }

    if (isThoughtChainEntry(entry)) {
      parts.push(entry.messages.map(message => message.bodyMarkdown).join("\n\n"))
      continue
    }

    if (isAssistantMessageEntry(entry)) {
      parts.push(entry.bodyMarkdown)
    }
  }

  return `${parts.filter(Boolean).join("\n\n").trim()}\n`
}

function buildSearchDocument(params: {
  session: SessionListItem
  sessionContent: string
  markdownPath: string
  signature: string
}): SearchDocument {
  const transcript = buildConversationTranscript({
    session: params.session,
    sessionContent: params.sessionContent,
    sessionPath: params.session.sessionPath,
    options: {
      includeCommentary: true,
      includeDiffs: false
    }
  })

  const firstUserMessage =
    transcript.entries.find(
      entry => entry.kind === "message" && entry.role === "user"
    )?.bodyMarkdown ?? null
  const previewText =
    firstUserMessage ??
    (() => {
      const previewEntry = transcript.entries.find(
        entry =>
          (entry.kind === "message" && entry.role === "assistant") ||
          entry.kind === "thought_chain"
      )

      if (!previewEntry) {
        return params.session.threadName
      }

      if (previewEntry.kind === "thought_chain") {
        return previewEntry.messages[0]?.bodyMarkdown ?? params.session.threadName
      }

      return previewEntry.bodyMarkdown
    })()

  const markdown = formatSearchDocumentMarkdown({
    threadName: params.session.threadName,
    firstUserMessage,
    entries: transcript.entries
  })
  const searchableText = stripMarkdown(markdown)

  return {
    id: params.session.id,
    sourceSessionId: params.session.sourceSessionId,
    provider: params.session.provider,
    archived: params.session.archived,
    threadName: params.session.threadName,
    createdAt: params.session.createdAt,
    updatedAt: params.session.updatedAt,
    projectPath: transcript.projectPath ?? params.session.projectPath,
    sessionPath: params.session.sessionPath!,
    signature: params.signature,
    markdownPath: params.markdownPath,
    previewText: stripMarkdown(previewText),
    firstUserMessage: firstUserMessage ? stripMarkdown(firstUserMessage) : null,
    searchableText,
    embedding: null
  }
}

class TransformersEmbedder implements SearchEmbedder {
  private extractorPromise: Promise<any> | null = null

  async embed(text: string) {
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        const { env, pipeline } = await import("@xenova/transformers")
        env.allowRemoteModels = true
        env.allowLocalModels = true
        return pipeline("feature-extraction", SEARCH_MODEL_ID)
      })()
    }

    const extractor = await this.extractorPromise
    const result = await extractor(text, {
      pooling: "mean",
      normalize: true
    })
    return Array.from(result.data as ArrayLike<number>)
  }

  async dispose() {
    return
  }
}

export function createHandoffSearchService(
  options: HandoffSearchServiceOptions
): HandoffSearchService {
  const searchDir = path.join(options.dataDir, "search")
  const documentsDir = path.join(searchDir, "documents")
  const indexPath = path.join(searchDir, "index.json")
  const events = new EventEmitter()
  const embedder = options.embedder ?? new TransformersEmbedder()
  const queryEmbeddingCache = new Map<string, number[]>()

  let documentsById = new Map<string, SearchDocument>()
  let status: SearchStatus = {
    state: "warming",
    message: "Preparing search…",
    indexedAt: null,
    documentCount: 0
  }
  let cacheLoaded = false
  let syncInFlight = false
  let queuedSessions: SessionListItem[] | null = null

  function emitStatus(nextStatus: SearchStatus) {
    status = nextStatus
    events.emit("status-changed", nextStatus)
  }

  async function ensureDirectories() {
    await fs.mkdir(documentsDir, { recursive: true })
  }

  async function loadPersistedIndex() {
    if (cacheLoaded) {
      return
    }

    cacheLoaded = true

    try {
      const raw = await fs.readFile(indexPath, "utf8")
      const parsed = JSON.parse(raw) as PersistedSearchIndex
      if (parsed.version !== SEARCH_INDEX_VERSION || !Array.isArray(parsed.documents)) {
        return
      }

      documentsById = new Map(parsed.documents.map(document => [document.id, document]))
      emitStatus({
        state: documentsById.size > 0 ? "ready" : "warming",
        message: documentsById.size > 0 ? null : "Preparing search…",
        indexedAt: parsed.indexedAt ?? null,
        documentCount: documentsById.size
      })
    } catch {
      return
    }
  }

  async function persistIndex(indexedAt: string | null) {
    await ensureDirectories()
    const payload: PersistedSearchIndex = {
      version: SEARCH_INDEX_VERSION,
      indexedAt,
      documents: [...documentsById.values()]
    }
    await fs.writeFile(indexPath, JSON.stringify(payload), "utf8")
  }

  async function buildSessionSignature(session: SessionListItem) {
    if (!session.sessionPath) {
      return `${session.id}:${session.threadName}:${session.updatedAt}`
    }

    const stat = await fs.stat(session.sessionPath)
    return JSON.stringify({
      threadName: session.threadName,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archived: session.archived,
      provider: session.provider,
      projectPath: session.projectPath,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs)
    })
  }

  async function ensureEmbedding(document: SearchDocument) {
    if (document.embedding && document.embedding.length > 0) {
      return document.embedding
    }

    const embedding = await embedder.embed(document.searchableText)
    document.embedding = embedding
    return embedding
  }

  async function performSync(sessions: SessionListItem[]) {
    await ensureDirectories()
    await loadPersistedIndex()

    const nextDocuments = new Map<string, SearchDocument>()
    const activeDocumentPaths = new Set<string>()

    emitStatus({
      state: "warming",
      message: status.indexedAt ? "Updating search index…" : "Building search index…",
      indexedAt: status.indexedAt,
      documentCount: documentsById.size
    })

    for (const session of sessions) {
      if (!session.sessionPath) {
        continue
      }

      const signature = await buildSessionSignature(session)
      const markdownPath = path.join(documentsDir, `${encodeURIComponent(session.id)}.md`)
      const existingDocument = documentsById.get(session.id)

      if (existingDocument && existingDocument.signature === signature) {
        nextDocuments.set(session.id, {
          ...existingDocument,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          threadName: session.threadName,
          archived: session.archived,
          projectPath: session.projectPath,
          markdownPath,
          sessionPath: session.sessionPath
        })
        activeDocumentPaths.add(markdownPath)
        continue
      }

      const sessionContent = await fs.readFile(session.sessionPath, "utf8")
      const nextDocument = buildSearchDocument({
        session,
        sessionContent,
        markdownPath,
        signature
      })
      await fs.writeFile(markdownPath, formatSearchDocumentMarkdown({
        threadName: nextDocument.threadName,
        firstUserMessage: nextDocument.firstUserMessage,
        entries: buildConversationTranscript({
          session,
          sessionContent,
          sessionPath: session.sessionPath,
          options: {
            includeCommentary: true,
            includeDiffs: false
          }
        }).entries
      }), "utf8")
      nextDocuments.set(session.id, nextDocument)
      activeDocumentPaths.add(markdownPath)
    }

    const staleDocuments = [...documentsById.values()].filter(
      document => !nextDocuments.has(document.id)
    )

    documentsById = nextDocuments

    for (const staleDocument of staleDocuments) {
      try {
        await fs.unlink(staleDocument.markdownPath)
      } catch {
        continue
      }
    }

    for (const document of documentsById.values()) {
      if (!document.embedding) {
        await ensureEmbedding(document)
      }
    }

    queryEmbeddingCache.clear()
    const indexedAt = new Date().toISOString()
    await persistIndex(indexedAt)
    emitStatus({
      state: "ready",
      message: null,
      indexedAt,
      documentCount: documentsById.size
    })
  }

  async function syncSessions(sessions: SessionListItem[]) {
    queuedSessions = sessions
    if (syncInFlight) {
      return
    }

    syncInFlight = true

    while (queuedSessions) {
      const nextSessions = queuedSessions
      queuedSessions = null

      try {
        await performSync(nextSessions)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to build search index."
        emitStatus({
          state: "error",
          message,
          indexedAt: status.indexedAt,
          documentCount: documentsById.size
        })
      }
    }

    syncInFlight = false
  }

  async function getQueryEmbedding(query: string) {
    const cachedEmbedding = queryEmbeddingCache.get(query)
    if (cachedEmbedding) {
      return cachedEmbedding
    }

    const embedding = await embedder.embed(query)
    queryEmbeddingCache.set(query, embedding)

    if (queryEmbeddingCache.size > QUERY_CACHE_LIMIT) {
      const oldestKey = queryEmbeddingCache.keys().next().value
      if (oldestKey) {
        queryEmbeddingCache.delete(oldestKey)
      }
    }

    return embedding
  }

  return {
    async getStatus() {
      await loadPersistedIndex()
      return status
    },

    async query(params) {
      await loadPersistedIndex()

      const limit = Math.max(1, Math.min(params.limit, 100))
      const trimmedQuery = params.query.trim()
      const filteredDocuments = applySearchFilters(
        [...documentsById.values()],
        params.filters
      )

      if (!trimmedQuery) {
        return filteredDocuments
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, limit)
          .map(document => ({
            id: document.id,
            sourceSessionId: document.sourceSessionId,
            provider: document.provider,
            archived: document.archived,
            threadName: document.threadName,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            projectPath: document.projectPath,
            sessionPath: document.sessionPath,
            snippet: document.previewText,
            score: 1
          }))
      }

      const shouldUseLexicalFallback =
        trimmedQuery.length < 3 ||
        filteredDocuments.length === 0 ||
        status.state !== "ready"

      if (shouldUseLexicalFallback) {
        return filteredDocuments
          .map(document => ({
            document,
            score: buildLexicalScore(document, trimmedQuery)
          }))
          .filter(result => result.score > 0)
          .sort(
            (left, right) =>
              right.score - left.score ||
              right.document.updatedAt.localeCompare(left.document.updatedAt)
          )
          .slice(0, limit)
          .map(({ document, score }) => ({
            id: document.id,
            sourceSessionId: document.sourceSessionId,
            provider: document.provider,
            archived: document.archived,
            threadName: document.threadName,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            projectPath: document.projectPath,
            sessionPath: document.sessionPath,
            snippet: buildSnippet(document, trimmedQuery),
            score
          }))
      }

      const queryEmbedding = await getQueryEmbedding(trimmedQuery)

      return filteredDocuments
        .map(document => {
          const lexicalScore = buildLexicalScore(document, trimmedQuery)
          const semanticScore = document.embedding
            ? dotProduct(queryEmbedding, document.embedding)
            : 0

          return {
            document,
            score: semanticScore + lexicalScore * 0.01
          }
        })
        .filter(result => result.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.document.updatedAt.localeCompare(left.document.updatedAt)
        )
        .slice(0, limit)
        .map(({ document, score }) => ({
          id: document.id,
          sourceSessionId: document.sourceSessionId,
          provider: document.provider,
          archived: document.archived,
          threadName: document.threadName,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
          projectPath: document.projectPath,
          sessionPath: document.sessionPath,
          snippet: buildSnippet(document, trimmedQuery),
          score
        }))
    },

    onStatusChanged(listener) {
      events.on("status-changed", listener)
      return () => {
        events.off("status-changed", listener)
      }
    },

    async syncSessions(sessions) {
      await syncSessions(sessions)
    },

    async dispose() {
      queryEmbeddingCache.clear()
      await embedder.dispose?.()
      events.removeAllListeners()
    }
  }
}

export { applySearchFilters, buildSearchDocument, formatSearchDocumentMarkdown, stripMarkdown }
