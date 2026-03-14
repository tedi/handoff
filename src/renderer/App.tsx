import { useCallback, useEffect, useMemo, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import type {
  AppStateInfo,
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
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [lastEvent, setLastEvent] = useState<HandoffStateChangeEvent | null>(null)

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

  const loadTranscript = useCallback(async (session: SessionListItem | null) => {
    if (!session) {
      setActiveTranscript(null)
      setTranscriptError(null)
      return
    }

    if (!session.sessionPath) {
      setActiveTranscript(null)
      setTranscriptError(null)
      return
    }

    setIsLoadingTranscript(true)
    const api = getHandoffApi()

    if (!api) {
      setActiveTranscript(null)
      setTranscriptError("The preload bridge did not load. Restart the app.")
      setIsLoadingTranscript(false)
      return
    }

    try {
      const transcript = await api.sessions.getTranscript(session.id, {
        includeCommentary: false,
        includeDiffs: true
      })
      setActiveTranscript(transcript)
      setTranscriptError(null)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to load transcript."
      setActiveTranscript(null)
      setTranscriptError(message)
    } finally {
      setIsLoadingTranscript(false)
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
      setCopyStatus(current =>
        current === successLabel ? null : current
      )
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
    void loadTranscript(activeSession)
  }, [activeSession, loadTranscript])

  useEffect(() => {
    const api = getHandoffApi()
    if (!api) {
      return () => undefined
    }

    return api.app.onStateChanged(event => {
      setLastEvent(event)

      if (event.reason === "selected-session-changed") {
        const selectedSession = sessions.find(session => session.id === activeSessionId) ?? null
        void loadTranscript(selectedSession)
        return
      }

      void loadSessions(activeSessionId)
    })
  }, [activeSessionId, loadSessions, loadTranscript, sessions])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <img alt="Handoff icon" className="topbar-mark" src={appIconUrl} />
          <div>
            <p className="eyebrow">Codex Sessions</p>
            <h1>Handoff</h1>
            <p className="status-line">
              Browse Codex conversations from `session_index.jsonl` and inspect their
              parsed transcript with inline diffs.
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
                      {formatTimestamp(session.updatedAt)}
                    </span>
                  </div>
                  <span className="session-subtitle">
                    {session.sessionPath ? session.id : "Missing session file"}
                  </span>
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
                detail="Pick a conversation from the left sidebar to inspect its parsed transcript."
              />
            ) : !activeSession.sessionPath ? (
              <EmptyState
                title="Session file missing"
                detail="This thread still exists in the index, but no matching session JSONL file could be resolved from `~/.codex/sessions`."
              />
            ) : transcriptError ? (
              <EmptyState
                title="Unable to parse conversation"
                detail={transcriptError}
              />
            ) : isLoadingTranscript && !activeTranscript ? (
              <EmptyState
                title="Loading transcript"
                detail="Reading and parsing the selected session file."
              />
            ) : activeTranscript ? (
              <div className="markdown-shell">
                <ReactMarkdown
                  components={{
                    a({ href, children }) {
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
                  }}
                  remarkPlugins={[remarkGfm]}
                >
                  {activeTranscript.markdown}
                </ReactMarkdown>
              </div>
            ) : (
              <EmptyState
                title="Transcript unavailable"
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
