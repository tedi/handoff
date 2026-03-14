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
          markdown: "# Transcript\n\n## User\nOlder user\n\n## Assistant\nOlder answer\n",
          lastAssistantMarkdown: "Older answer",
          hasDiffs: false
        },
        "session-2": {
          id: "session-2",
          threadName: "Newest session",
          updatedAt: "2026-03-14T02:00:00.000Z",
          sessionPath: "/tmp/session-2.jsonl",
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
    expect(screen.getByText("Patch 1")).toBeInTheDocument()

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
