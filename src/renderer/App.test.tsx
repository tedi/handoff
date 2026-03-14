// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AppStateInfo,
  ConversationTranscript,
  HandoffApi,
  HandoffStateChangeEvent,
  SessionListItem
} from "../shared/contracts"
import App from "./App"

function createMockApi({
  sessions,
  transcriptById,
  transcriptErrors = {}
}: {
  sessions: SessionListItem[]
  transcriptById: Record<string, ConversationTranscript>
  transcriptErrors?: Record<string, Error>
}) {
  const stateInfo: AppStateInfo = {
    indexPath: "/Users/tedikonda/.codex/session_index.jsonl",
    sessionsRoot: "/Users/tedikonda/.codex/sessions",
    outputDir: "/Users/tedikonda/ai/handoff/output"
  }
  const listeners = new Set<(event: HandoffStateChangeEvent) => void>()

  const api: HandoffApi = {
    app: {
      getStateInfo: vi.fn().mockResolvedValue(stateInfo),
      refresh: vi.fn().mockResolvedValue({
        at: "2026-03-14T00:20:00.000Z",
        reason: "manual-refresh",
        changedPath: null
      }),
      onStateChanged(listener) {
        listeners.add(listener)

        return () => {
          listeners.delete(listener)
        }
      }
    },
    sessions: {
      list: vi.fn().mockResolvedValue(sessions),
      getTranscript: vi.fn().mockImplementation(async (id: string, options) => {
        if (!options.includeDiffs) {
          const transcript = transcriptById[id]
          return {
            ...transcript,
            markdown: transcript.markdown.replace(/\n### Diffs[\s\S]+$/m, "")
          }
        }

        const error = transcriptErrors[id]
        if (error) {
          throw error
        }

        return transcriptById[id]
      })
    },
    clipboard: {
      writeText: vi.fn().mockResolvedValue({ copied: true })
    }
  }

  return {
    api,
    emit(event: HandoffStateChangeEvent) {
      listeners.forEach(listener => listener(event))
    }
  }
}

describe("Handoff App", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("loads and switches conversations from the sidebar", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "session-2",
          threadName: "Newest session",
          updatedAt: "2026-03-14T02:00:00.000Z",
          sessionPath: "/tmp/session-2.jsonl"
        },
        {
          id: "session-1",
          threadName: "Older session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          sessionPath: "/tmp/session-1.jsonl"
        }
      ],
      transcriptById: {
        "session-1": {
          id: "session-1",
          threadName: "Older session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          sessionPath: "/tmp/session-1.jsonl",
          entries: [
            {
              id: "session-1-user",
              kind: "message",
              role: "user",
              timestamp: "2026-03-14T01:00:01.000Z",
              bodyMarkdown: "Older user"
            },
            {
              id: "session-1-assistant",
              kind: "message",
              role: "assistant",
              timestamp: "2026-03-14T01:00:02.000Z",
              bodyMarkdown: "Older answer",
              patches: []
            }
          ],
          markdown: "# Transcript\n\n## User\nOlder user\n\n## Assistant\nOlder answer\n",
          lastAssistantMarkdown: "Older answer",
          hasDiffs: false
        },
        "session-2": {
          id: "session-2",
          threadName: "Newest session",
          updatedAt: "2026-03-14T02:00:00.000Z",
          sessionPath: "/tmp/session-2.jsonl",
          entries: [
            {
              id: "session-2-user",
              kind: "message",
              role: "user",
              timestamp: "2026-03-14T02:00:01.000Z",
              bodyMarkdown: "Hello"
            },
            {
              id: "session-2-commentary",
              kind: "commentary",
              role: "assistant",
              timestamp: "2026-03-14T02:00:02.000Z",
              bodyMarkdown: "Tracing swipe path in highlights.tsx.\n\nChecking gesture ownership.",
              collapsedByDefault: true,
              previewText: "Tracing swipe path in highlights.tsx."
            },
            {
              id: "session-2-assistant",
              kind: "message",
              role: "assistant",
              timestamp: "2026-03-14T02:00:03.000Z",
              bodyMarkdown: "Newest answer",
              patches: [
                {
                  id: "session-2-patch-1",
                  files: ["/tmp/demo.ts"],
                  patch: "+test"
                }
              ]
            }
          ],
          markdown:
            "# Transcript\n\n## User\nHello\n\n## Assistant\nNewest answer\n\n### Diffs\n\n#### Patch 1\nFiles: /tmp/demo.ts\n\n```diff\n+test\n```\n",
          lastAssistantMarkdown: "Newest answer",
          hasDiffs: true
        }
      }
    })

    window.handoffApp = api
    render(<App />)

    await screen.findByRole("button", { name: /Newest session/i })
    expect(await screen.findByText("Newest answer")).toBeInTheDocument()
    expect(screen.getByText("Tracing swipe path in highlights.tsx.")).toBeInTheDocument()
    expect(screen.queryByText("Checking gesture ownership.")).not.toBeInTheDocument()
    expect(screen.getByText("/tmp/demo.ts")).toBeInTheDocument()
    expect(screen.queryByText("Transcript")).not.toBeInTheDocument()
    expect(screen.queryByText(/^User$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Assistant$/)).not.toBeInTheDocument()
    expect(screen.getByText("Hello").closest(".user-bubble")).not.toBeNull()
    expect(screen.getByText("Newest answer").closest(".assistant-entry")).not.toBeNull()

    await userEvent.click(
      screen.getByRole("button", { name: /Tracing swipe path in highlights\.tsx\./i })
    )

    expect(await screen.findByText("Checking gesture ownership.")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Older session/i }))

    await waitFor(() => {
      expect(screen.getByText("Older answer")).toBeInTheDocument()
    })
  })

  it("copies the expected markdown variants", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "session-1",
          threadName: "Copy session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          sessionPath: "/tmp/session-1.jsonl"
        }
      ],
      transcriptById: {
        "session-1": {
          id: "session-1",
          threadName: "Copy session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          sessionPath: "/tmp/session-1.jsonl",
          entries: [
            {
              id: "copy-user",
              kind: "message",
              role: "user",
              timestamp: "2026-03-14T01:00:01.000Z",
              bodyMarkdown: "Hello"
            },
            {
              id: "copy-commentary",
              kind: "commentary",
              role: "assistant",
              timestamp: "2026-03-14T01:00:02.000Z",
              bodyMarkdown: "Tracing",
              collapsedByDefault: true,
              previewText: "Tracing"
            },
            {
              id: "copy-assistant",
              kind: "message",
              role: "assistant",
              timestamp: "2026-03-14T01:00:03.000Z",
              bodyMarkdown: "Final answer",
              patches: [
                {
                  id: "copy-patch-1",
                  files: ["/tmp/demo.ts"],
                  patch: "+test"
                }
              ]
            }
          ],
          markdown:
            "# Transcript\n\n## User\nHello\n\n## Assistant\nFinal answer\n\n### Diffs\n\n#### Patch 1\nFiles: /tmp/demo.ts\n\n```diff\n+test\n```\n",
          lastAssistantMarkdown: "Final answer",
          hasDiffs: true
        }
      }
    })

    window.handoffApp = api
    render(<App />)

    await screen.findByText("Final answer")

    await userEvent.click(screen.getByRole("button", { name: "Copy Chat" }))
    await userEvent.click(screen.getByRole("button", { name: "Copy Chat + Diffs" }))
    await userEvent.click(screen.getByRole("button", { name: "Copy Last Message" }))

    expect(api.clipboard.writeText).toHaveBeenNthCalledWith(
      1,
      "# Transcript\n\n## User\nHello\n\n## Assistant\nFinal answer\n"
    )
    expect(api.clipboard.writeText).toHaveBeenNthCalledWith(
      2,
      "# Transcript\n\n## User\nHello\n\n## Assistant\nFinal answer\n\n### Diffs\n\n#### Patch 1\nFiles: /tmp/demo.ts\n\n```diff\n+test\n```\n"
    )
    expect(api.clipboard.writeText).toHaveBeenNthCalledWith(3, "Final answer")
  })

  it("shows a missing-session state when no file path is available", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "session-1",
          threadName: "Missing session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          sessionPath: null
        }
      ],
      transcriptById: {}
    })

    window.handoffApp = api
    render(<App />)

    expect(await screen.findByText("Session file missing")).toBeInTheDocument()
  })

  it("shows a parse error state when transcript loading fails", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "session-1",
          threadName: "Broken session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          sessionPath: "/tmp/session-1.jsonl"
        }
      ],
      transcriptById: {
        "session-1": {
          id: "session-1",
          threadName: "Broken session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          sessionPath: "/tmp/session-1.jsonl",
          entries: [],
          markdown: "",
          lastAssistantMarkdown: null,
          hasDiffs: false
        }
      },
      transcriptErrors: {
        "session-1": new Error("Invalid JSON on line 2")
      }
    })

    window.handoffApp = api
    render(<App />)

    expect(await screen.findByText("Unable to parse conversation")).toBeInTheDocument()
    expect(screen.getByText("Invalid JSON on line 2")).toBeInTheDocument()
  })
})
