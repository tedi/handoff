import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { buildConversationTranscript } from "./parser"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function loadFixture(name: string) {
  return fs.readFile(path.join(__dirname, "test", "fixtures", name), "utf8")
}

describe("buildConversationTranscript", () => {
  it("excludes commentary and scaffold prompts by default", async () => {
    const transcript = buildConversationTranscript({
      sessionContent: await loadFixture("sample-session.jsonl"),
      session: {
        id: "session-1",
        threadName: "Highlights regression",
        updatedAt: "2026-03-14T00:18:45.474Z"
      },
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
  })

  it("includes commentary when requested", async () => {
    const transcript = buildConversationTranscript({
      sessionContent: await loadFixture("sample-session.jsonl"),
      session: {
        id: "session-1",
        threadName: "Highlights regression",
        updatedAt: "2026-03-14T00:18:45.474Z"
      },
      sessionPath: "/tmp/session.jsonl",
      options: {
        includeCommentary: true,
        includeDiffs: false
      }
    })

    expect(transcript.markdown).toContain("I’m tracing the swipe flow first.")
    expect(transcript.markdown).not.toContain("### Diffs")
  })

  it("returns the final assistant reply as lastAssistantMarkdown", async () => {
    const transcript = buildConversationTranscript({
      sessionContent: await loadFixture("sample-session.jsonl"),
      session: {
        id: "session-1",
        threadName: "Highlights regression",
        updatedAt: "2026-03-14T00:18:45.474Z"
      },
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
  })

  it("throws on malformed JSON lines", () => {
    expect(() =>
      buildConversationTranscript({
        sessionContent: '{"type":"response_item"}\nnot-json\n',
        session: {
          id: "session-1",
          threadName: "Broken session",
          updatedAt: "2026-03-14T00:18:45.474Z"
        },
        sessionPath: "/tmp/session.jsonl",
        options: {
          includeCommentary: false,
          includeDiffs: true
        }
      })
    ).toThrow(/Invalid JSON on line 2/)
  })

  it("ignores malformed message and patch payloads without crashing", () => {
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
      session: {
        id: "session-1",
        threadName: "Hello world",
        updatedAt: "2026-03-14T00:18:45.474Z"
      },
      sessionPath: "/tmp/session.jsonl",
      options: {
        includeCommentary: false,
        includeDiffs: true
      }
    })

    expect(transcript.markdown).toContain("## User")
    expect(transcript.markdown).toContain("## Assistant")
  })
})
