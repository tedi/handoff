import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
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
  HandoffStateChangeEvent,
  SessionListItem
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
  const [lastEvent, setLastEvent] = useState<HandoffStateChangeEvent | null>(null)
  const [expandedThoughtChainIds, setExpandedThoughtChainIds] = useState<Set<string>>(
    () => new Set()
  )

  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions]
  )

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

  const handleOpenInCodex = useCallback(async () => {
    if (!activeSession?.id || activeTranscript?.id !== activeSession.id) {
      return
    }

    const api = getHandoffApi()
    if (!api) {
      setCopyStatus("Preload bridge unavailable")
      return
    }

    try {
      await api.app.openCodexThread(
        activeSession.id,
        activeTranscript.sessionClient,
        activeTranscript.sessionCwd
      )
      setCopyStatus("Opened in Codex")
      window.setTimeout(() => {
        setCopyStatus(current => (current === "Opened in Codex" ? null : current))
      }, 2400)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to open Codex"
      setCopyStatus(message)
    }
  }, [activeSession, activeTranscript])

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
    const api = getHandoffApi()
    if (!api) {
      return () => undefined
    }

    return api.app.onStateChanged(event => {
      setLastEvent(event)

      if (event.reason === "selected-session-changed") {
        const selectedSession =
          sessions.find(session => session.id === activeSessionId) ?? null
        void loadConversation(selectedSession)
        return
      }

      void loadSessions(activeSessionId)
    })
  }, [activeSessionId, loadConversation, loadSessions, sessions])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          {activeSession ? (
            <>
              <span className="topbar-thread">{activeSession.threadName}</span>
              <span className="topbar-separator">&middot;</span>
              <span className="topbar-updated">
                {formatTimestamp(activeSession.updatedAt)}
              </span>
              {activeTranscript?.hasDiffs ? (
                <span className="topbar-badge">Diffs</span>
              ) : null}
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

      <div className="workspace">
        <section className="sidebar-pane">
          <div className="session-list" role="list">
            {isLoadingSessions && sessions.length === 0 ? (
              <EmptyState
                title="Loading sessions"
                detail="Reading the Codex session index and resolving available conversation files."
              />
            ) : sessions.length === 0 ? (
              <EmptyState
                title="No sessions found"
                detail="No conversation entries were available from the session index."
              />
            ) : (
              sessions.map(session => (
                <button
                  key={`${session.id}:${session.updatedAt}:${session.threadName}`}
                  className={`session-row ${
                    session.id === activeSessionId ? "is-active" : ""
                  }`}
                  onClick={() => setActiveSessionId(session.id)}
                  type="button"
                >
                  <div className="session-row-main">
                    <span className="session-title">{session.threadName}</span>
                    <span className="session-time">
                      {formatRelativeTimestamp(session.updatedAt)}
                    </span>
                  </div>
                  {!session.sessionPath ? (
                    <span className="session-subtitle">Missing session file</span>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </section>

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
                detail="This thread still exists in the index, but no matching session JSONL file could be resolved from `~/.codex/sessions`."
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
                  onClick={() => void handleOpenInCodex()}
                  type="button"
                >
                  {stateInfo?.codexIconDataUrl ? (
                    <img
                      alt=""
                      aria-hidden="true"
                      className="codex-thread-icon"
                      src={stateInfo.codexIconDataUrl}
                    />
                  ) : (
                    <span aria-hidden="true" className="codex-thread-fallback">
                      C
                    </span>
                  )}
                  <span>Open in Codex</span>
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
      </div>
    </div>
  )
}
