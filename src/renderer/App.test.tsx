// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AppStateInfo,
  ConversationTranscript,
  HandoffApi,
  HandoffSettingsSnapshot,
  HandoffStateChangeEvent,
  SearchResult,
  SearchStatus,
  SessionListItem
} from "../shared/contracts"
import App from "./App"

function createMockApi({
  sessions,
  transcriptById,
  transcriptErrors = {},
  searchStatus,
  searchQuery
}: {
  sessions: SessionListItem[]
  transcriptById: Record<string, ConversationTranscript>
  transcriptErrors?: Record<string, Error>
  searchStatus?: SearchStatus
  searchQuery?: (params: {
    query: string
    filters: import("../shared/contracts").SearchFilters
    limit: number
  }) => SearchResult[] | Promise<SearchResult[]>
}) {
  const stateInfo: AppStateInfo = {
    indexPath: "/Users/tedikonda/.codex/session_index.jsonl",
    sessionsRoot: "/Users/tedikonda/.codex/sessions",
    claudeProjectsRoot: "/Users/tedikonda/.claude/projects",
    outputDir: "/Users/tedikonda/ai/handoff/output",
    codexIconDataUrl: "data:image/png;base64,ZmFrZQ==",
    claudeIconDataUrl: "data:image/png;base64,Y2xhdWRl"
  }
  const settingsSnapshot: HandoffSettingsSnapshot = {
    settings: {
      providers: {
        codex: {
          binaryPath: "",
          homePath: ""
        },
        claude: {
          binaryPath: "",
          homePath: ""
        }
      },
      terminals: {
        enabledTerminalIds: ["terminal", "ghostty", "warp"],
        defaultTerminalId: "terminal"
      }
    },
    providerInfo: {
      codex: {
        provider: "codex",
        binarySource: "default",
        effectiveBinaryPath: "codex",
        homeSource: "default",
        effectiveHomePath: "/Users/tedikonda/.codex",
        configPath: "/Users/tedikonda/.codex/config.toml",
        configExists: true,
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
        effortLevel: null,
        alwaysThinkingEnabled: null,
        observedModel: null
      },
      claude: {
        provider: "claude",
        binarySource: "default",
        effectiveBinaryPath: "claude",
        homeSource: "default",
        effectiveHomePath: "/Users/tedikonda/.claude",
        configPath: "/Users/tedikonda/.claude/settings.json",
        configExists: true,
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        effortLevel: "high",
        alwaysThinkingEnabled: true,
        observedModel: "claude-opus-4-6"
      }
    },
    terminalOptions: [
      { id: "terminal", label: "Terminal", installed: true },
      { id: "ghostty", label: "Ghostty", installed: true },
      { id: "warp", label: "Warp", installed: true }
    ]
  }
  const listeners = new Set<(event: HandoffStateChangeEvent) => void>()
  const searchStatusListeners = new Set<
    (status: import("../shared/contracts").SearchStatus) => void
  >()

  const api: HandoffApi = {
    app: {
      getStateInfo: vi.fn().mockResolvedValue(stateInfo),
      refresh: vi.fn().mockResolvedValue({
        at: "2026-03-14T00:20:00.000Z",
        reason: "manual-refresh",
        changedPath: null
      }),
      openSourceSession: vi.fn().mockResolvedValue({ fallbackMessage: null }),
      startNewThread: vi.fn().mockResolvedValue({
        launchMode: "cli",
        copiedPrompt: false,
        fallbackMessage: null
      }),
      openProjectPath: vi.fn().mockResolvedValue({ fallbackMessage: null }),
      onStateChanged(listener) {
        listeners.add(listener)

        return () => {
          listeners.delete(listener)
        }
      }
    },
    settings: {
      get: vi.fn().mockResolvedValue(settingsSnapshot),
      update: vi.fn().mockImplementation(async patch => ({
        ...settingsSnapshot,
        settings: {
          ...settingsSnapshot.settings,
          providers: {
            codex: {
              ...settingsSnapshot.settings.providers.codex,
              ...(patch.providers?.codex ?? {})
            },
            claude: {
              ...settingsSnapshot.settings.providers.claude,
              ...(patch.providers?.claude ?? {})
            }
          },
          terminals: {
            ...settingsSnapshot.settings.terminals,
            ...(patch.terminals ?? {})
          }
        }
      })),
      resetProvider: vi.fn().mockResolvedValue(settingsSnapshot)
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
    search: {
      getStatus: vi.fn().mockResolvedValue(
        searchStatus ?? {
          state: "ready",
          message: null,
          indexedAt: "2026-03-14T00:20:00.000Z",
          documentCount: sessions.length
        }
      ),
      query: vi.fn().mockImplementation(async params =>
        searchQuery ? searchQuery(params) : []
      ),
      onStatusChanged(listener) {
        searchStatusListeners.add(listener)

        return () => {
          searchStatusListeners.delete(listener)
        }
      }
    },
    clipboard: {
      writeText: vi.fn().mockResolvedValue({ copied: true })
    }
  }

  return {
    api,
    emit(event: HandoffStateChangeEvent) {
      listeners.forEach(listener => listener(event))
    },
    emitSearchStatus(status: import("../shared/contracts").SearchStatus) {
      searchStatusListeners.forEach(listener => listener(status))
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
          archived: false,
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
          archived: false,
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

    await userEvent.click(screen.getByRole("button", { name: /Open in Codex/i }))

    expect(api.app.openSourceSession).toHaveBeenLastCalledWith(
      "codex",
      "session-1",
      "desktop",
      "/tmp/codex-project"
    )
  })

  it("copies the expected markdown variants through the split copy button", async () => {
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

    await userEvent.click(screen.getByRole("button", { name: "Copy Chat + Diffs" }))
    expect(await screen.findByText("Copied chat + diffs as Markdown")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Open copy options" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy Chat" }))
    expect(await screen.findByText("Copied chat as Markdown")).toBeInTheDocument()

    expect(screen.getByRole("button", { name: "Copy Chat" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Copy Chat" }))

    await userEvent.click(screen.getByRole("button", { name: "Output format: Markdown" }))
    expect(screen.getByRole("menuitemradio", { name: /Structured/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("menuitemradio", { name: /JSON/i }))
    expect(screen.getByRole("button", { name: "Output format: JSON" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Open copy options" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy Last Message" }))
    expect(await screen.findByText("Copied last message as JSON")).toBeInTheDocument()

    expect(api.clipboard.writeText).toHaveBeenNthCalledWith(
      1,
      "## User\n\nHello\n\n## Assistant\n\nFinal answer\n\n### Diffs\n\n#### Patch 1\n\nFiles: /tmp/demo.ts\n\n```diff\n*** Begin Patch\n*** Update File: /tmp/demo.ts\n@@ -1,1 +1,1 @@\n-const value = 1\n+const value = 2\n*** End Patch\n```\n"
    )
    expect(api.clipboard.writeText).toHaveBeenNthCalledWith(
      2,
      "## User\n\nHello\n\n## Assistant\n\nFinal answer\n"
    )
    expect(api.clipboard.writeText).toHaveBeenNthCalledWith(
      3,
      "## User\n\nHello\n\n## Assistant\n\nFinal answer\n"
    )
    expect(api.clipboard.writeText).toHaveBeenNthCalledWith(
      4,
      '{\n  "type": "assistant_message",\n  "threadName": "Copy session",\n  "provider": "claude",\n  "archived": false,\n  "updatedAt": "2026-03-14T01:00:00.000Z",\n  "projectPath": "/tmp/project",\n  "message": {\n    "role": "assistant",\n    "timestamp": "2026-03-14T01:00:03.000Z",\n    "markdown": "Final answer"\n  }\n}\n'
    )
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

  it("applies sidebar filters with the documented defaults", async () => {
    const now = Date.now()
    const recentClaudeUpdatedAt = new Date(now - 24 * 60 * 60 * 1000).toISOString()
    const recentCodexUpdatedAt = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()
    const archivedCodexUpdatedAt = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString()
    const oldClaudeUpdatedAt = new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString()

    const { api } = createMockApi({
      sessions: [
        {
          id: "claude:handoff",
          sourceSessionId: "handoff",
          provider: "claude",
          archived: false,
          threadName: "Handoff recent",
          updatedAt: recentClaudeUpdatedAt,
          projectPath: "/Users/tedikonda/ai/handoff",
          sessionPath: "/tmp/handoff.jsonl"
        },
        {
          id: "codex:client",
          sourceSessionId: "client",
          provider: "codex",
          archived: false,
          threadName: "Client recent",
          updatedAt: recentCodexUpdatedAt,
          projectPath: "/Users/tedikonda/topchallenger/apps/client",
          sessionPath: "/tmp/client.jsonl"
        },
        {
          id: "codex:archived",
          sourceSessionId: "archived",
          provider: "codex",
          archived: true,
          threadName: "Archived recent",
          updatedAt: archivedCodexUpdatedAt,
          projectPath: "/Users/tedikonda/topchallenger/apps",
          sessionPath: "/tmp/archived.jsonl"
        },
        {
          id: "claude:old",
          sourceSessionId: "old",
          provider: "claude",
          archived: false,
          threadName: "Old research",
          updatedAt: oldClaudeUpdatedAt,
          projectPath: "/Users/tedikonda/research",
          sessionPath: "/tmp/research.jsonl"
        }
      ],
      transcriptById: {
        "claude:handoff": {
          id: "claude:handoff",
          sourceSessionId: "handoff",
          provider: "claude",
          archived: false,
          threadName: "Handoff recent",
          updatedAt: recentClaudeUpdatedAt,
          projectPath: "/Users/tedikonda/ai/handoff",
          sessionPath: "/tmp/handoff.jsonl",
          sessionClient: "cli",
          sessionCwd: "/Users/tedikonda/ai/handoff",
          entries: [
            {
              id: "handoff-user",
              kind: "message",
              role: "user",
              timestamp: recentClaudeUpdatedAt,
              bodyMarkdown: "Hello"
            },
            {
              id: "handoff-assistant",
              kind: "message",
              role: "assistant",
              timestamp: recentClaudeUpdatedAt,
              bodyMarkdown: "Answer",
              patches: []
            }
          ],
          markdown: "# Transcript\n\n## User\nHello\n\n## Assistant\nAnswer\n",
          lastAssistantMarkdown: "Answer",
          hasDiffs: false
        },
        "codex:client": {
          id: "codex:client",
          sourceSessionId: "client",
          provider: "codex",
          archived: false,
          threadName: "Client recent",
          updatedAt: recentCodexUpdatedAt,
          projectPath: "/Users/tedikonda/topchallenger/apps/client",
          sessionPath: "/tmp/client.jsonl",
          sessionClient: "desktop",
          sessionCwd: "/Users/tedikonda/topchallenger/apps/client",
          entries: [],
          markdown: "",
          lastAssistantMarkdown: null,
          hasDiffs: false
        },
        "codex:archived": {
          id: "codex:archived",
          sourceSessionId: "archived",
          provider: "codex",
          archived: true,
          threadName: "Archived recent",
          updatedAt: archivedCodexUpdatedAt,
          projectPath: "/Users/tedikonda/topchallenger/apps",
          sessionPath: "/tmp/archived.jsonl",
          sessionClient: "desktop",
          sessionCwd: "/Users/tedikonda/topchallenger/apps",
          entries: [],
          markdown: "",
          lastAssistantMarkdown: null,
          hasDiffs: false
        },
        "claude:old": {
          id: "claude:old",
          sourceSessionId: "old",
          provider: "claude",
          archived: false,
          threadName: "Old research",
          updatedAt: oldClaudeUpdatedAt,
          projectPath: "/Users/tedikonda/research",
          sessionPath: "/tmp/research.jsonl",
          sessionClient: "cli",
          sessionCwd: "/Users/tedikonda/research",
          entries: [],
          markdown: "",
          lastAssistantMarkdown: null,
          hasDiffs: false
        }
      }
    })

    window.handoffApp = api
    render(<App />)

    expect(await screen.findByRole("button", { name: /Handoff recent/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Client recent/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Archived recent/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Old research/i })).not.toBeInTheDocument()

    const filterButton = screen.getByRole("button", { name: /Open filters/i })
    expect(filterButton).toHaveAttribute("aria-pressed", "false")

    await userEvent.click(filterButton)

    expect(await screen.findByRole("dialog", { name: /Session filters/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Archived/i }))
    await userEvent.click(screen.getByRole("button", { name: "All" }))
    expect(await screen.findByRole("button", { name: /Archived recent/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Provider/i }))
    await userEvent.click(screen.getByRole("button", { name: "Claude" }))
    expect(screen.queryByRole("button", { name: /Client recent/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Archived recent/i })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Date/i }))
    await userEvent.click(screen.getByRole("button", { name: "All dates" }))
    expect(await screen.findByRole("button", { name: /Old research/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Project/i }))
    await userEvent.click(screen.getByLabelText(/handoff/i))
    expect(screen.getByRole("button", { name: /Handoff recent/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Old research/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Close filters/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
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
    await userEvent.click(screen.getByRole("button", { name: /Open filters/i }))
    expect(await screen.findByRole("dialog", { name: /Session filters/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Expand sidebar/i }))
    expect(await screen.findByRole("button", { name: /Sidebar session/i })).toBeInTheDocument()
  })

  it("opens search mode and restores results after returning from a selected thread", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "codex:session-1",
          sourceSessionId: "session-1",
          provider: "codex",
          archived: false,
          threadName: "Gesture regression",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: "/tmp/session-1.jsonl"
        }
      ],
      transcriptById: {
        "codex:session-1": {
          id: "codex:session-1",
          sourceSessionId: "session-1",
          provider: "codex",
          archived: false,
          threadName: "Gesture regression",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: "/tmp/session-1.jsonl",
          sessionClient: "desktop",
          sessionCwd: "/tmp/project",
          entries: [
            {
              id: "search-user",
              kind: "message",
              role: "user",
              timestamp: "2026-03-14T01:00:01.000Z",
              bodyMarkdown: "The gesture handler upgrade broke the carousel swipe."
            },
            {
              id: "search-assistant",
              kind: "message",
              role: "assistant",
              timestamp: "2026-03-14T01:00:02.000Z",
              bodyMarkdown: "I found the regression in highlights.tsx.",
              patches: []
            }
          ],
          markdown: "# Transcript\n\n## User\nGesture issue\n\n## Assistant\nFound it\n",
          lastAssistantMarkdown: "I found the regression in highlights.tsx.",
          hasDiffs: false
        }
      },
      searchQuery: ({ query }) =>
        query.trim()
          ? [
              {
                id: "codex:session-1",
                sourceSessionId: "session-1",
                provider: "codex",
                archived: false,
                threadName: "Gesture regression",
                updatedAt: "2026-03-14T01:00:00.000Z",
                projectPath: "/tmp/project",
                sessionPath: "/tmp/session-1.jsonl",
                snippet: "The gesture handler upgrade broke the carousel swipe.",
                score: 0.92
              }
            ]
          : []
    })

    window.handoffApp = api
    render(<App />)

    expect(
      await screen.findByText("I found the regression in highlights.tsx.")
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Open search/i }))

    const searchInput = await screen.findByPlaceholderText("Search conversations")
    expect(searchInput).toHaveFocus()

    await userEvent.type(searchInput, "gesture")

    await waitFor(() => {
      expect(api.search.query).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "gesture",
          filters: expect.objectContaining({
            archived: "not-archived",
            dateRange: "30d",
            provider: "all",
            projectPaths: []
          })
        })
      )
    })

    const searchResultSnippet = await screen.findByText(
      "The gesture handler upgrade broke the carousel swipe."
    )

    await userEvent.click(searchResultSnippet.closest("button") as HTMLButtonElement)

    expect(
      await screen.findByText("I found the regression in highlights.tsx.")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Back to results/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Back to results/i }))

    expect(await screen.findByDisplayValue("gesture")).toBeInTheDocument()
    expect(
      await screen.findByText("The gesture handler upgrade broke the carousel swipe.")
    ).toBeInTheDocument()
  })

  it("opens settings and returns to the previous search results state", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "codex:session-1",
          sourceSessionId: "session-1",
          provider: "codex",
          archived: false,
          threadName: "Gesture regression",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: "/tmp/session-1.jsonl"
        }
      ],
      transcriptById: {
        "codex:session-1": {
          id: "codex:session-1",
          sourceSessionId: "session-1",
          provider: "codex",
          archived: false,
          threadName: "Gesture regression",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: "/tmp/session-1.jsonl",
          sessionClient: "desktop",
          sessionCwd: "/tmp/project",
          entries: [
            {
              id: "search-user",
              kind: "message",
              role: "user",
              timestamp: "2026-03-14T01:00:01.000Z",
              bodyMarkdown: "The gesture handler upgrade broke the carousel swipe."
            },
            {
              id: "search-assistant",
              kind: "message",
              role: "assistant",
              timestamp: "2026-03-14T01:00:02.000Z",
              bodyMarkdown: "I found the regression in highlights.tsx.",
              patches: []
            }
          ],
          markdown: "## User\nGesture issue\n\n## Assistant\nFound it\n",
          lastAssistantMarkdown: "I found the regression in highlights.tsx.",
          hasDiffs: false
        }
      },
      searchQuery: ({ query }) =>
        query.trim()
          ? [
              {
                id: "codex:session-1",
                sourceSessionId: "session-1",
                provider: "codex",
                archived: false,
                threadName: "Gesture regression",
                updatedAt: "2026-03-14T01:00:00.000Z",
                projectPath: "/tmp/project",
                sessionPath: "/tmp/session-1.jsonl",
                snippet: "The gesture handler upgrade broke the carousel swipe.",
                score: 0.92
              }
            ]
          : []
    })

    window.handoffApp = api
    render(<App />)

    await userEvent.click(screen.getByRole("button", { name: /Open search/i }))
    const searchInput = await screen.findByPlaceholderText("Search conversations")
    await userEvent.type(searchInput, "gesture")

    expect(
      await screen.findByText("The gesture handler upgrade broke the carousel swipe.")
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Open settings/i }))

    expect(await screen.findByText("Codex model info")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Back from settings/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Back from settings/i }))

    expect(await screen.findByDisplayValue("gesture")).toBeInTheDocument()
    expect(
      await screen.findByText("The gesture handler upgrade broke the carousel swipe.")
    ).toBeInTheDocument()
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

  it("opens the new-thread composer, seeds from the active thread, and starts with the selected target", async () => {
    const { api } = createMockApi({
      sessions: [
        {
          id: "codex:gesture",
          sourceSessionId: "gesture",
          provider: "codex",
          archived: false,
          threadName: "Gesture regression",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: "/tmp/session-1.jsonl"
        }
      ],
      transcriptById: {
        "codex:gesture": {
          id: "codex:gesture",
          sourceSessionId: "gesture",
          provider: "codex",
          archived: false,
          threadName: "Gesture regression",
          updatedAt: "2026-03-14T01:00:00.000Z",
          projectPath: "/tmp/project",
          sessionPath: "/tmp/session-1.jsonl",
          sessionClient: "desktop",
          sessionCwd: "/tmp/project",
          entries: [
            {
              id: "gesture-user",
              kind: "message",
              role: "user",
              timestamp: "2026-03-14T01:00:01.000Z",
              bodyMarkdown: "The gesture handler upgrade broke the carousel swipe."
            },
            {
              id: "gesture-thoughts",
              kind: "thought_chain",
              role: "assistant",
              timestamp: "2026-03-14T01:00:02.000Z",
              collapsedByDefault: true,
              messageCount: 1,
              messages: [
                {
                  id: "gesture-thought-step",
                  bodyMarkdown: "Tracing the swipe path."
                }
              ]
            },
            {
              id: "gesture-assistant",
              kind: "message",
              role: "assistant",
              timestamp: "2026-03-14T01:00:03.000Z",
              bodyMarkdown: "The regression is inside highlights.tsx.",
              patches: [
                {
                  id: "gesture-patch",
                  files: ["/tmp/highlights.tsx"],
                  patch: [
                    "*** Begin Patch",
                    "*** Update File: /tmp/highlights.tsx",
                    "@@ -1,1 +1,1 @@",
                    "-const broken = true",
                    "+const broken = false",
                    "*** End Patch"
                  ].join("\n")
                }
              ]
            }
          ],
          markdown: "## User\nGesture issue\n\n## Assistant\nFound it\n",
          lastAssistantMarkdown: "The regression is inside highlights.tsx.",
          hasDiffs: true
        }
      }
    })

    window.handoffApp = api
    render(<App />)

    expect(await screen.findByText("The regression is inside highlights.tsx.")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Open new thread/i }))

    expect(await screen.findByText("Start from existing thread")).toBeInTheDocument()
    expect(screen.getAllByText("Gesture regression").length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: "Copy + Open in Codex" })).toBeInTheDocument()

    const promptInput = screen.getByPlaceholderText(
      "Select a source thread to generate a prompt."
    ) as HTMLTextAreaElement

    await waitFor(() => {
      expect(promptInput.value).toContain("<thread_name>Gesture regression</thread_name>")
    })
    expect(promptInput.value).toContain("The gesture handler upgrade broke the carousel swipe.")
    expect(promptInput.value).not.toContain("*** Begin Patch")

    await userEvent.click(screen.getByLabelText("Include diffs"))

    await waitFor(() => {
      expect(promptInput.value).toContain("*** Begin Patch")
    })

    await userEvent.click(screen.getByRole("button", { name: "Copy + Open in Codex" }))

    expect(api.app.startNewThread).toHaveBeenCalledWith({
      provider: "codex",
      launchMode: "app",
      projectPath: "/tmp/project",
      prompt: expect.stringContaining("*** Begin Patch"),
      thinkingLevel: "high",
      fast: false
    })
  })
})
