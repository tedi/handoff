import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createHandoffService } from "./service"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface TestEnvironment {
  appDir: string
  baseDir: string
  codexHome: string
  claudeHome: string
  codexExistingId: string
  codexMissingId: string
  codexSessionFilePath: string
  claudeIndexedId: string
  claudeIndexedSessionPath: string
  claudeFallbackId: string
  claudeFallbackSessionPath: string
  claudeIndexPath: string
}

async function loadFixture(name: string) {
  return fs.readFile(
    path.join(__dirname, "../shared/test/fixtures", name),
    "utf8"
  )
}

function buildClaudeSession(params: {
  sessionId: string
  cwd: string
  prompt: string
  interimText?: string
  finalText: string
  patchFilePath?: string
}) {
  const records: string[] = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-03-14T00:20:00.000Z",
      cwd: params.cwd,
      sessionId: params.sessionId,
      isSidechain: false,
      message: {
        role: "user",
        content: [{ type: "text", text: params.prompt }]
      }
    })
  ]

  if (params.interimText) {
    records.push(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-03-14T00:20:01.000Z",
        cwd: params.cwd,
        sessionId: params.sessionId,
        isSidechain: false,
        message: {
          role: "assistant",
          content: [{ type: "text", text: params.interimText }],
          stop_reason: null
        }
      })
    )
  }

  if (params.patchFilePath) {
    records.push(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-03-14T00:20:02.000Z",
        cwd: params.cwd,
        sessionId: params.sessionId,
        isSidechain: false,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `tool-${params.sessionId}`,
              name: "Edit",
              input: { file_path: params.patchFilePath }
            }
          ],
          stop_reason: "tool_use"
        }
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-14T00:20:03.000Z",
        cwd: params.cwd,
        sessionId: params.sessionId,
        isSidechain: false,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `tool-${params.sessionId}` }]
        },
        toolUseResult: {
          filePath: params.patchFilePath,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-const value = 1", "+const value = 2"]
            }
          ],
          originalFile: "const value = 1"
        }
      })
    )
  }

  records.push(
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-03-14T00:20:04.000Z",
      cwd: params.cwd,
      sessionId: params.sessionId,
      isSidechain: false,
      message: {
        role: "assistant",
        content: [{ type: "text", text: params.finalText }],
        stop_reason: "end_turn"
      }
    })
  )

  return records.join("\n")
}

async function createTestEnvironment(): Promise<TestEnvironment> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-app-"))
  const appDir = path.join(baseDir, "app")
  const codexHome = path.join(baseDir, ".codex")
  const claudeHome = path.join(baseDir, ".claude")
  const sessionsDir = path.join(codexHome, "sessions", "2026", "03", "14")
  const claudeIndexedProjectDir = path.join(
    claudeHome,
    "projects",
    "-Users-tedikonda-topchallenger-apps"
  )
  const claudeFallbackProjectDir = path.join(
    claudeHome,
    "projects",
    "-Users-tedikonda-ai-handoff"
  )

  const codexExistingId = "019ce9aa-04f8-7860-883a-1ceb41b9ac31"
  const codexMissingId = "019ce9aa-04f8-7860-883a-1ceb41b9ac32"
  const claudeIndexedId = "9a728c6c-c2df-4570-871e-217aac26a29c"
  const claudeFallbackId = "7f5d8b1d-4b9b-45c2-93d8-87323df5d4ea"

  const codexSessionFilePath = path.join(
    sessionsDir,
    `rollout-2026-03-13T17-05-59-${codexExistingId}.jsonl`
  )
  const claudeIndexedSessionPath = path.join(
    claudeIndexedProjectDir,
    `${claudeIndexedId}.jsonl`
  )
  const claudeFallbackSessionPath = path.join(
    claudeFallbackProjectDir,
    `${claudeFallbackId}.jsonl`
  )
  const claudeIndexPath = path.join(claudeIndexedProjectDir, "sessions-index.json")

  await fs.mkdir(appDir, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })
  await fs.mkdir(claudeIndexedProjectDir, { recursive: true })
  await fs.mkdir(path.join(claudeFallbackProjectDir, "subagents"), { recursive: true })
  await fs.writeFile(
    path.join(codexHome, "session_index.jsonl"),
    [
      JSON.stringify({
        id: codexExistingId,
        thread_name: "Older highlights title",
        updated_at: "2026-03-14T00:17:45.474Z"
      }),
      JSON.stringify({
        id: codexMissingId,
        thread_name: "Missing Codex session",
        updated_at: "2026-03-14T00:19:45.474Z"
      }),
      JSON.stringify({
        id: codexExistingId,
        thread_name: "Highlights regression",
        updated_at: "2026-03-14T00:18:45.474Z"
      })
    ].join("\n")
  )
  await fs.writeFile(
    codexSessionFilePath,
    [
      JSON.stringify({
        timestamp: "2026-03-14T00:08:49.033Z",
        type: "session_meta",
        payload: {
          id: codexExistingId,
          timestamp: "2026-03-14T00:05:59.676Z",
          cwd: "/Users/tedikonda/topchallenger/apps/client",
          originator: "Codex Desktop",
          source: "vscode"
        }
      }),
      await loadFixture("sample-session.jsonl")
    ].join("\n")
  )

  await fs.writeFile(
    claudeIndexedSessionPath,
    buildClaudeSession({
      sessionId: claudeIndexedId,
      cwd: "/Users/tedikonda/topchallenger/apps",
      prompt: "Review the merged handoff UI",
      interimText: "Let me inspect the changed files.",
      finalText: "All 17 tests pass.",
      patchFilePath: "/Users/tedikonda/ai/handoff/src/renderer/App.tsx"
    })
  )
  await fs.writeFile(
    claudeIndexPath,
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            sessionId: claudeIndexedId,
            fullPath: claudeIndexedSessionPath,
            summary: "Claude indexed session",
            firstPrompt: "No prompt",
            modified: "2026-03-14T00:21:00.000Z",
            projectPath: "/Users/tedikonda/topchallenger/apps",
            isSidechain: false
          },
          {
            sessionId: "subagent-session",
            fullPath: path.join(claudeIndexedProjectDir, "subagent-session.jsonl"),
            summary: "Should not appear",
            modified: "2026-03-14T00:22:00.000Z",
            projectPath: "/Users/tedikonda/topchallenger/apps",
            isSidechain: true
          }
        ]
      },
      null,
      2
    )
  )

  await fs.writeFile(
    claudeFallbackSessionPath,
    buildClaudeSession({
      sessionId: claudeFallbackId,
      cwd: "/Users/tedikonda/ai/handoff",
      prompt: "Fallback Claude session",
      interimText: "Checking current layout.",
      finalText: "Fallback done."
    })
  )
  await fs.writeFile(
    path.join(claudeFallbackProjectDir, "subagents", "ignored.jsonl"),
    buildClaudeSession({
      sessionId: "ignored-subagent",
      cwd: "/Users/tedikonda/ai/handoff",
      prompt: "Ignored subagent",
      finalText: "Should never be listed."
    })
  )

  return {
    appDir,
    baseDir,
    codexHome,
    claudeHome,
    codexExistingId,
    codexMissingId,
    codexSessionFilePath,
    claudeIndexedId,
    claudeIndexedSessionPath,
    claudeFallbackId,
    claudeFallbackSessionPath,
    claudeIndexPath
  }
}

async function waitForStateChange(
  service: ReturnType<typeof createHandoffService>,
  reason: string
) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for ${reason}.`))
    }, 2000)

    const unsubscribe = service.onStateChanged(event => {
      if (event.reason !== reason) {
        return
      }

      clearTimeout(timeout)
      unsubscribe()
      resolve(event)
    })
  })
}

describe("handoff service", () => {
  let env: TestEnvironment
  let service: ReturnType<typeof createHandoffService>

  beforeEach(async () => {
    env = await createTestEnvironment()
    service = createHandoffService({
      appDir: env.appDir,
      codexHome: env.codexHome,
      claudeHome: env.claudeHome
    })
  })

  afterEach(async () => {
    await service.dispose()
    await fs.rm(env.baseDir, { recursive: true, force: true })
  })

  it("merges Codex and Claude sessions newest-first, prefers Claude index metadata, and resolves paths", async () => {
    const sessions = await service.sessions.list()

    expect(sessions.map(session => session.id)).toEqual([
      `claude:${env.claudeIndexedId}`,
      `claude:${env.claudeFallbackId}`,
      `codex:${env.codexMissingId}`,
      `codex:${env.codexExistingId}`
    ])
    expect(sessions.map(session => session.threadName)).toEqual([
      "Claude indexed session",
      "Fallback Claude session",
      "Missing Codex session",
      "Highlights regression"
    ])
    expect(sessions[0]).toMatchObject({
      provider: "claude",
      projectPath: "/Users/tedikonda/topchallenger/apps",
      sessionPath: env.claudeIndexedSessionPath
    })
    expect(sessions[1]).toMatchObject({
      provider: "claude",
      projectPath: "/Users/tedikonda/ai/handoff",
      sessionPath: env.claudeFallbackSessionPath
    })
    expect(sessions[2]?.sessionPath).toBeNull()
  })

  it("returns a parsed transcript for a Claude session using the shared transcript model", async () => {
    const transcript = await service.sessions.getTranscript(`claude:${env.claudeIndexedId}`, {
      includeCommentary: false,
      includeDiffs: true
    })

    expect(transcript.provider).toBe("claude")
    expect(transcript.threadName).toBe("Claude indexed session")
    expect(transcript.projectPath).toBe("/Users/tedikonda/topchallenger/apps")
    expect(transcript.sessionClient).toBe("cli")
    expect(transcript.markdown).toContain("All 17 tests pass.")
    expect(transcript.markdown).toContain("### Diffs")
    expect(transcript.entries.map(entry => entry.kind)).toEqual([
      "message",
      "thought_chain",
      "message"
    ])
  })

  it("emits a selected-session-changed event when the watched Claude session file changes", async () => {
    await service.startWatching()
    await service.sessions.getTranscript(`claude:${env.claudeIndexedId}`, {
      includeCommentary: false,
      includeDiffs: true
    })

    const eventPromise = waitForStateChange(service, "selected-session-changed")
    await fs.appendFile(env.claudeIndexedSessionPath, "\n")
    await expect(eventPromise).resolves.toMatchObject({
      reason: "selected-session-changed",
      changedPath: env.claudeIndexedSessionPath
    })
  })

  it("emits an index-changed event when the Codex session index changes", async () => {
    await service.startWatching()
    await new Promise(resolve => setTimeout(resolve, 150))

    const eventPromise = waitForStateChange(service, "index-changed")
    await fs.appendFile(path.join(env.codexHome, "session_index.jsonl"), "\n")

    await expect(eventPromise).resolves.toMatchObject({
      reason: "index-changed",
      changedPath: path.join(env.codexHome, "session_index.jsonl")
    })
  })

  it("emits a manual-refresh event through the app api", async () => {
    await expect(service.app.refresh()).resolves.toMatchObject({
      reason: "manual-refresh"
    })
  })
})
