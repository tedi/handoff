import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import type { AssistantMessageEntry, AssistantThoughtChainEntry, SessionIndexEntry } from "./contracts"
import { buildConversationTranscript } from "./parser"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function loadFixture(name: string) {
  return fs.readFile(path.join(__dirname, "test", "fixtures", name), "utf8")
}

function createSession(overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  const provider = overrides.provider ?? "codex"
  const sourceSessionId = overrides.sourceSessionId ?? "session-1"

  return {
    id: overrides.id ?? `${provider}:${sourceSessionId}`,
    sourceSessionId,
    provider,
    threadName: overrides.threadName ?? "Highlights regression",
    updatedAt: overrides.updatedAt ?? "2026-03-14T00:18:45.474Z",
    projectPath: overrides.projectPath ?? null
  }
}

describe("buildConversationTranscript", () => {
  it("bundles Codex commentary into thought chains while excluding them from markdown by default", async () => {
    const transcript = buildConversationTranscript({
      sessionContent: await loadFixture("sample-session.jsonl"),
      session: createSession(),
      sessionPath: "/tmp/session.jsonl",
      options: {
        includeCommentary: false,
        includeDiffs: true
      }
    })

    expect(transcript.markdown).toContain("Investigate highlights swipe regression")
    expect(transcript.markdown).not.toContain("AGENTS.md instructions")
    expect(transcript.markdown).not.toContain("I’m tracing the swipe flow first.")
    expect(transcript.markdown).toContain("### Diffs")
    expect(transcript.entries.map(entry => entry.kind)).toEqual([
      "message",
      "thought_chain",
      "message",
      "message",
      "message"
    ])
  })

  it("includes Codex commentary in markdown when requested", async () => {
    const transcript = buildConversationTranscript({
      sessionContent: await loadFixture("sample-session.jsonl"),
      session: createSession(),
      sessionPath: "/tmp/session.jsonl",
      options: {
        includeCommentary: true,
        includeDiffs: false
      }
    })

    expect(transcript.markdown).toContain("I’m tracing the swipe flow first.")
    expect(transcript.markdown).not.toContain("### Diffs")
  })

  it("attaches Codex diffs to the matching assistant message entry", async () => {
    const transcript = buildConversationTranscript({
      sessionContent: await loadFixture("sample-session.jsonl"),
      session: createSession(),
      sessionPath: "/tmp/session.jsonl",
      options: {
        includeCommentary: false,
        includeDiffs: true
      }
    })

    const assistantEntries = transcript.entries.filter(
      (entry): entry is AssistantMessageEntry =>
        entry.role === "assistant" && entry.kind === "message"
    )

    expect(assistantEntries[0]?.patches).toHaveLength(1)
    expect(assistantEntries[0]?.patches[0]?.files).toEqual(["/tmp/project/highlights.tsx"])
    expect(assistantEntries[1]?.patches).toHaveLength(0)
  })

  it("groups consecutive Codex commentary messages into one thought chain entry", () => {
    const transcript = buildConversationTranscript({
      sessionContent: [
        JSON.stringify({
          timestamp: "2026-03-14T00:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hello" }]
          }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "First thought" }]
          }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Second thought" }]
          }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T00:00:04.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Final answer" }]
          }
        })
      ].join("\n"),
      session: createSession(),
      sessionPath: "/tmp/session.jsonl",
      options: {
        includeCommentary: false,
        includeDiffs: false
      }
    })

    const thoughtChain = transcript.entries.find(
      (entry): entry is AssistantThoughtChainEntry => entry.kind === "thought_chain"
    )

    expect(thoughtChain).toMatchObject({
      messageCount: 2,
      collapsedByDefault: true
    })
    expect(thoughtChain?.messages.map(message => message.bodyMarkdown)).toEqual([
      "First thought",
      "Second thought"
    ])
  })

  it("returns the final Codex assistant reply as lastAssistantMarkdown", async () => {
    const transcript = buildConversationTranscript({
      sessionContent: await loadFixture("sample-session.jsonl"),
      session: createSession(),
      sessionPath: "/tmp/session.jsonl",
      options: {
        includeCommentary: false,
        includeDiffs: true
      }
    })

    expect(transcript.lastAssistantMarkdown).toBe(
      "I found two issues in the same carousel and patched both."
    )
    expect(transcript.hasDiffs).toBe(true)
    expect(
      transcript.entries.find(
        (entry): entry is AssistantThoughtChainEntry => entry.kind === "thought_chain"
      )
    ).toMatchObject({
      collapsedByDefault: true,
      messageCount: 1
    })
  })

  it("throws on malformed JSON lines", () => {
    expect(() =>
      buildConversationTranscript({
        sessionContent: '{"type":"response_item"}\nnot-json\n',
        session: createSession({ threadName: "Broken session" }),
        sessionPath: "/tmp/session.jsonl",
        options: {
          includeCommentary: false,
          includeDiffs: true
        }
      })
    ).toThrow(/Invalid JSON on line 2/)
  })

  it("ignores malformed Codex message and patch payloads without crashing", () => {
    const transcript = buildConversationTranscript({
      sessionContent: [
        JSON.stringify({
          timestamp: "2026-03-14T00:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hello" }]
          }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T00:00:02.000Z",
          type: "response_item",
          payload: { type: "custom_tool_call", name: "apply_patch" }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "World" }]
          }
        })
      ].join("\n"),
      session: createSession({ threadName: "Hello world" }),
      sessionPath: "/tmp/session.jsonl",
      options: {
        includeCommentary: false,
        includeDiffs: true
      }
    })

    expect(transcript.markdown).toContain("## User")
    expect(transcript.markdown).toContain("## Assistant")
  })

  it("normalizes Claude sessions into the shared message, thought chain, and patch model", () => {
    const transcript = buildConversationTranscript({
      sessionContent: [
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-14T05:34:29.869Z",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content: [{ type: "text", text: "Please update the UI." }]
          }
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-14T05:34:29.870Z",
          cwd: "/tmp/project",
          isMeta: true,
          message: {
            role: "user",
            content: [{ type: "text", text: "meta" }]
          }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-14T05:34:36.660Z",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "hidden" }],
            stop_reason: null
          }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-14T05:34:37.117Z",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Let me inspect the current UI structure." }
            ],
            stop_reason: null
          }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-14T05:34:40.399Z",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-read",
                name: "Read",
                input: { file_path: "/tmp/project/src/App.tsx" }
              }
            ],
            stop_reason: "tool_use"
          }
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-14T05:34:40.500Z",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-read" }]
          },
          toolUseResult: {
            numFiles: 2,
            content: "read summary"
          }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-14T05:34:50.000Z",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-edit",
                name: "Edit",
                input: { file_path: "/tmp/project/src/App.tsx" }
              }
            ],
            stop_reason: "tool_use"
          }
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-14T05:34:51.000Z",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-edit" }]
          },
          toolUseResult: {
            filePath: "/tmp/project/src/App.tsx",
            structuredPatch: [
              {
                oldStart: 10,
                oldLines: 1,
                newStart: 10,
                newLines: 1,
                lines: ["-const a = 1", "+const a = 2"]
              }
            ],
            originalFile: "const a = 1"
          }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-14T05:41:28.980Z",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done. Tests pass." }],
            stop_reason: "end_turn"
          }
        })
      ].join("\n"),
      session: createSession({
        provider: "claude",
        id: "claude:session-2",
        sourceSessionId: "session-2",
        threadName: "Claude UI cleanup",
        projectPath: "/tmp/project"
      }),
      sessionPath: "/tmp/session.jsonl",
      options: {
        includeCommentary: false,
        includeDiffs: true
      }
    })

    expect(transcript.provider).toBe("claude")
    expect(transcript.sessionClient).toBe("cli")
    expect(transcript.projectPath).toBe("/tmp/project")
    expect(transcript.markdown).toContain("Done. Tests pass.")
    expect(transcript.markdown).not.toContain("Let me inspect the current UI structure.")
    expect(transcript.markdown).toContain("### Diffs")
    expect(transcript.lastAssistantMarkdown).toBe("Done. Tests pass.")

    expect(transcript.entries.map(entry => entry.kind)).toEqual([
      "message",
      "thought_chain",
      "message"
    ])

    const thoughtChain = transcript.entries.find(
      (entry): entry is AssistantThoughtChainEntry => entry.kind === "thought_chain"
    )
    expect(thoughtChain?.messages.map(message => message.bodyMarkdown)).toEqual([
      "Let me inspect the current UI structure.",
      "Read 2 files",
      "Update App.tsx"
    ])

    const assistantEntry = transcript.entries.find(
      (entry): entry is AssistantMessageEntry =>
        entry.kind === "message" && entry.role === "assistant"
    )
    expect(assistantEntry?.patches).toHaveLength(1)
    expect(assistantEntry?.patches[0]?.files).toEqual(["/tmp/project/src/App.tsx"])
    expect(assistantEntry?.patches[0]?.patch).toContain("*** Update File: /tmp/project/src/App.tsx")
    expect(assistantEntry?.patches[0]?.patch).toContain("@@ -10,1 +10,1 @@")
  })

  it("synthesizes Claude add-file patches when create results have no structured patch", () => {
    const transcript = buildConversationTranscript({
      sessionContent: [
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-14T06:00:00.000Z",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content: [{ type: "text", text: "Create a file" }]
          }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-14T06:00:01.000Z",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-write",
                name: "Write",
                input: { file_path: "/tmp/project/src/new.ts" }
              }
            ],
            stop_reason: "tool_use"
          }
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-14T06:00:02.000Z",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-write" }]
          },
          toolUseResult: {
            type: "create",
            filePath: "/tmp/project/src/new.ts",
            content: "export const value = 1"
          }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-14T06:00:03.000Z",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Created the file." }],
            stop_reason: "end_turn"
          }
        })
      ].join("\n"),
      session: createSession({
        provider: "claude",
        id: "claude:session-3",
        sourceSessionId: "session-3",
        threadName: "Create file",
        projectPath: "/tmp/project"
      }),
      sessionPath: "/tmp/session.jsonl",
      options: {
        includeCommentary: false,
        includeDiffs: true
      }
    })

    const assistantEntry = transcript.entries.find(
      (entry): entry is AssistantMessageEntry =>
        entry.kind === "message" && entry.role === "assistant"
    )

    expect(assistantEntry?.patches[0]?.patch).toContain("*** Add File: /tmp/project/src/new.ts")
    expect(assistantEntry?.patches[0]?.patch).toContain("+export const value = 1")
  })
})
