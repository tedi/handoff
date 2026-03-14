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
    claudeProjectsRoot: "/Users/tedikonda/.claude/projects",
    outputDir: "/Users/tedikonda/ai/handoff/output",
    codexIconDataUrl: "data:image/png;base64,ZmFrZQ==",
    claudeIconDataUrl: "data:image/png;base64,Y2xhdWRl"
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
      openSourceSession: vi.fn().mockResolvedValue(undefined),
      openProjectPath: vi.fn().mockResolvedValue(undefined),
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
        const error = transcriptErrors[id]
        if (error && options.includeDiffs) {
          throw error
        }

        const transcript = transcriptById[id]
        if (!options.includeDiffs) {
          return {
            ...transcript,
            markdown: transcript.markdown.replace(/\n### Diffs[\s\S]+$/m, "")
          }
        }

        return transcript
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
    window.localStorage.clear()
  })

  it("renders a mixed-source sidebar and switches source-aware actions with the selected transcript", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "claude:session-2",
          sourceSessionId: "session-2",
          provider: "claude",
          archived: false,
          threadName: "Claude newest session",
          updatedAt: "2026-03-14T02:00:00.000Z",
          projectPath: "/tmp/claude-project",
          sessionPath: "/tmp/session-2.jsonl"
        },
        {
          id: "codex:session-1",
          sourceSessionId: "session-1",
          provider: "codex",
          archived: true,
          threadName: "Codex older session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: null,
          sessionPath: "/tmp/session-1.jsonl"
        }
      ],
      transcriptById: {
        "codex:session-1": {
          id: "codex:session-1",
          sourceSessionId: "session-1",
          provider: "codex",
          archived: true,
          threadName: "Codex older session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/codex-project",
          sessionPath: "/tmp/session-1.jsonl",
          sessionClient: "desktop",
          sessionCwd: "/tmp/codex-project",
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
        "claude:session-2": {
          id: "claude:session-2",
          sourceSessionId: "session-2",
          provider: "claude",
          archived: false,
          threadName: "Claude newest session",
          updatedAt: "2026-03-14T02:00:00.000Z",
          projectPath: "/tmp/claude-project",
          sessionPath: "/tmp/session-2.jsonl",
          sessionClient: "cli",
          sessionCwd: "/tmp/claude-project",
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
              kind: "thought_chain",
              role: "assistant",
              timestamp: "2026-03-14T02:00:02.000Z",
              collapsedByDefault: true,
              messageCount: 2,
              messages: [
                {
                  id: "session-2-thought-1",
                  bodyMarkdown: "Tracing swipe path in highlights.tsx."
                },
                {
                  id: "session-2-thought-2",
                  bodyMarkdown: "Read 2 files"
                }
              ]
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
                  patch: [
                    "*** Begin Patch",
                    "*** Update File: /tmp/demo.ts",
                    "@@ -1,1 +1,1 @@",
                    "-const value = 1",
                    "+const value = 2",
                    "*** End Patch"
                  ].join("\n")
                },
                {
                  id: "session-2-patch-2",
                  files: ["/tmp/extra.ts"],
                  patch: [
                    "*** Begin Patch",
                    "*** Add File: /tmp/extra.ts",
                    "+export const extra = true",
                    "*** End Patch"
                  ].join("\n")
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

    await screen.findByRole("button", { name: /Claude newest session/i })
    expect(await screen.findByText("Newest answer")).toBeInTheDocument()
    expect(screen.getAllByTitle("Claude").length).toBeGreaterThan(0)
    expect(screen.getAllByTitle("Archived").length).toBe(1)
    expect(screen.getByText("Thought chain (2)")).toBeInTheDocument()
    expect(screen.getByText("2 files changed")).toBeInTheDocument()
    expect(screen.getByText("Hello").closest(".user-bubble")).not.toBeNull()
    expect(screen.getByText("Newest answer").closest(".assistant-entry")).not.toBeNull()
    expect(screen.getByText("/tmp/claude-project")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Open in Claude/i })
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Thought chain \(2\)/i }))

    expect(await screen.findByText("Tracing swipe path in highlights.tsx.")).toBeInTheDocument()
    expect(await screen.findByText("Read 2 files")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /\/tmp\/demo\.ts/i }))

    expect(
      await screen.findByText((_content, element) =>
        element?.textContent === "const value = 2"
      )
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Open in Claude/i }))

    expect(api.app.openSourceSession).toHaveBeenCalledWith(
      "claude",
      "session-2",
      "cli",
      "/tmp/claude-project"
    )

    await userEvent.click(screen.getByRole("button", { name: "Editor" }))

    expect(api.app.openProjectPath).toHaveBeenCalledWith("editor", "/tmp/claude-project")

    await userEvent.click(screen.getByRole("button", { name: /Codex older session/i }))

    await waitFor(() => {
      expect(screen.getByText("Older answer")).toBeInTheDocument()
    })
    expect(screen.getAllByTitle("Archived").length).toBe(2)

    await userEvent.click(screen.getByRole("button", { name: /Open in Codex/i }))

    expect(api.app.openSourceSession).toHaveBeenLastCalledWith(
      "codex",
      "session-1",
      "desktop",
      "/tmp/codex-project"
    )
  })

  it("copies the expected markdown variants", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "claude:session-1",
          sourceSessionId: "session-1",
          provider: "claude",
          archived: false,
          threadName: "Copy session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: "/tmp/session-1.jsonl"
        }
      ],
      transcriptById: {
        "claude:session-1": {
          id: "claude:session-1",
          sourceSessionId: "session-1",
          provider: "claude",
          archived: false,
          threadName: "Copy session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: "/tmp/session-1.jsonl",
          sessionClient: "cli",
          sessionCwd: "/tmp/project",
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
              kind: "thought_chain",
              role: "assistant",
              timestamp: "2026-03-14T01:00:02.000Z",
              collapsedByDefault: true,
              messageCount: 1,
              messages: [
                {
                  id: "copy-thought-1",
                  bodyMarkdown: "Tracing"
                }
              ]
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
                  patch: [
                    "*** Begin Patch",
                    "*** Update File: /tmp/demo.ts",
                    "@@ -1,1 +1,1 @@",
                    "-const value = 1",
                    "+const value = 2",
                    "*** End Patch"
                  ].join("\n")
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
          id: "claude:session-1",
          sourceSessionId: "session-1",
          provider: "claude",
          archived: false,
          threadName: "Missing session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: null
        }
      ],
      transcriptById: {}
    })

    window.handoffApp = api
    render(<App />)

    expect(await screen.findByText("Session file missing")).toBeInTheDocument()
  })

  it("collapses and expands the sidebar session list", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "claude:session-1",
          sourceSessionId: "session-1",
          provider: "claude",
          archived: false,
          threadName: "Sidebar session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: "/tmp/session-1.jsonl"
        }
      ],
      transcriptById: {
        "claude:session-1": {
          id: "claude:session-1",
          sourceSessionId: "session-1",
          provider: "claude",
          archived: false,
          threadName: "Sidebar session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: "/tmp/session-1.jsonl",
          sessionClient: "cli",
          sessionCwd: "/tmp/project",
          entries: [
            {
              id: "sidebar-user",
              kind: "message",
              role: "user",
              timestamp: "2026-03-14T01:00:01.000Z",
              bodyMarkdown: "Hello"
            },
            {
              id: "sidebar-assistant",
              kind: "message",
              role: "assistant",
              timestamp: "2026-03-14T01:00:02.000Z",
              bodyMarkdown: "Answer",
              patches: []
            }
          ],
          markdown: "# Transcript\n\n## User\nHello\n\n## Assistant\nAnswer\n",
          lastAssistantMarkdown: "Answer",
          hasDiffs: false
        }
      }
    })

    window.handoffApp = api
    render(<App />)

    expect(await screen.findByRole("button", { name: /Sidebar session/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Collapse sidebar/i }))
    expect(screen.queryByRole("button", { name: /Sidebar session/i })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Expand sidebar/i }))
    expect(await screen.findByRole("button", { name: /Sidebar session/i })).toBeInTheDocument()
  })

  it("shows a parse error state when transcript loading fails", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "codex:session-1",
          sourceSessionId: "session-1",
          provider: "codex",
          archived: false,
          threadName: "Broken session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: null,
          sessionPath: "/tmp/session-1.jsonl"
        }
      ],
      transcriptById: {
        "codex:session-1": {
          id: "codex:session-1",
          sourceSessionId: "session-1",
          provider: "codex",
          archived: false,
          threadName: "Broken session",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: null,
          sessionPath: "/tmp/session-1.jsonl",
          entries: [],
          markdown: "",
          lastAssistantMarkdown: null,
          hasDiffs: false
        }
      },
      transcriptErrors: {
        "codex:session-1": new Error("Invalid JSON on line 2")
      }
    })

    window.handoffApp = api
    render(<App />)

    expect(await screen.findByText("Unable to parse conversation")).toBeInTheDocument()
    expect(screen.getByText("Invalid JSON on line 2")).toBeInTheDocument()
  })
})
