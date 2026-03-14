import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

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
import appIconUrl from "./assets/handoff-icon.png"

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

function SessionMeta({
  label,
  value
}: {
  label: string
  value: string | null | undefined
}) {
  return (
    <div className="meta-item">
      <p className="meta-label">{label}</p>
      <p className="meta-value">{value || "Unavailable"}</p>
    </div>
  )
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

function PatchList({ patches }: { patches: ConversationPatch[] }) {
  if (patches.length === 0) {
    return null
  }

  return (
    <div className="patch-panel">
      <div className="patch-panel-header">
        <span>{patches.length === 1 ? "1 patch" : `${patches.length} patches`}</span>
      </div>

      {patches.map(patch => (
        <div className="patch-card" key={patch.id}>
          <div className="patch-files">
            {patch.files.length > 0 ? patch.files.join(", ") : "Unknown files"}
          </div>
          <pre>
            <code className="language-diff">{patch.patch}</code>
          </pre>
        </div>
      ))}
    </div>
  )
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
        <span className={`thought-chain-chevron ${expanded ? "is-open" : ""}`}>›</span>
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
        <div className="topbar-brand">
          <img alt="Handoff icon" className="topbar-mark" src={appIconUrl} />
          <div>
            <p className="eyebrow">Codex Sessions</p>
            <h1>Handoff</h1>
            <p className="status-line">
              Browse Codex conversations from `session_index.jsonl` and inspect each
              parsed conversation with inline diffs.
            </p>
          </div>
        </div>

        <div className="toolbar">
          <button
            className="ghost-button"
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

      <div className="summary-bar">
        <SessionMeta label="Session Index" value={stateInfo?.indexPath} />
        <SessionMeta label="Sessions Root" value={stateInfo?.sessionsRoot} />
        <SessionMeta
          label="Sessions"
          value={`${sessions.length}${isLoadingSessions ? " loading" : ""}`}
        />
        <SessionMeta
          label="Last Event"
          value={
            lastEvent
              ? `${lastEvent.reason} · ${formatTimestamp(lastEvent.at)}`
              : "Idle"
          }
        />
      </div>

      <div className="workspace">
        <section className="pane sidebar-pane">
          <div className="pane-header">
            <div>
              <p className="pane-label">Threads</p>
              <h2>Recent Conversations</h2>
            </div>
            <span className="count-pill">{sessions.length}</span>
          </div>

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
                  key={session.id}
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

        <section className="pane detail-pane">
          <div className="pane-header detail-header">
            <div>
              <p className="pane-label">Conversation</p>
              <h2>{activeSession?.threadName ?? "Select a conversation"}</h2>
            </div>
            {activeSession ? (
              <div className="detail-meta">
                <span>{formatTimestamp(activeSession.updatedAt)}</span>
                <span>{activeTranscript?.hasDiffs ? "Diffs included" : "No diffs"}</span>
              </div>
            ) : null}
          </div>

          <div className="detail-info-grid">
            <SessionMeta label="Thread Name" value={activeSession?.threadName} />
            <SessionMeta label="Updated" value={activeSession?.updatedAt ?? null} />
            <SessionMeta label="Session Path" value={activeSession?.sessionPath} />
          </div>

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
            <div className="copy-status">{copyStatus ?? " "}</div>
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
        </section>
      </div>
    </div>
  )
}
