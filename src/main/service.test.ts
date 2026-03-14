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
  existingSessionId: string
  missingSessionId: string
  sessionFilePath: string
}

async function loadFixture(name: string) {
  return fs.readFile(
    path.join(
      __dirname,
      "../shared/test/fixtures",
      name
    ),
    "utf8"
  )
}

async function createTestEnvironment(): Promise<TestEnvironment> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-app-"))
  const appDir = path.join(baseDir, "app")
  const codexHome = path.join(baseDir, ".codex")
  const sessionsDir = path.join(codexHome, "sessions", "2026", "03", "14")
  const existingSessionId = "019ce9aa-04f8-7860-883a-1ceb41b9ac31"
  const missingSessionId = "019ce9aa-04f8-7860-883a-1ceb41b9ac32"
  const sessionFilePath = path.join(
    sessionsDir,
    `rollout-2026-03-13T17-05-59-${existingSessionId}.jsonl`
  )

  await fs.mkdir(appDir, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })
  await fs.writeFile(
    path.join(codexHome, "session_index.jsonl"),
    [
      JSON.stringify({
        id: existingSessionId,
        thread_name: "Older highlights title",
        updated_at: "2026-03-14T00:17:45.474Z"
      }),
      JSON.stringify({
        id: missingSessionId,
        thread_name: "Missing session",
        updated_at: "2026-03-14T00:19:45.474Z"
      }),
      JSON.stringify({
        id: existingSessionId,
        thread_name: "Highlights regression",
        updated_at: "2026-03-14T00:18:45.474Z"
      })
    ].join("\n")
  )
  await fs.writeFile(sessionFilePath, await loadFixture("sample-session.jsonl"))

  return {
    appDir,
    baseDir,
    codexHome,
    existingSessionId,
    missingSessionId,
    sessionFilePath
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
      codexHome: env.codexHome
    })
  })

  afterEach(async () => {
    await service.dispose()
    await fs.rm(env.baseDir, { recursive: true, force: true })
  })

  it("lists deduped sessions sorted newest-first and resolves paths from filenames", async () => {
    const sessions = await service.sessions.list()

    expect(sessions.map(session => session.id)).toEqual([
      env.missingSessionId,
      env.existingSessionId
    ])
    expect(sessions.map(session => session.threadName)).toEqual([
      "Missing session",
      "Highlights regression"
    ])
    expect(sessions[0]?.sessionPath).toBeNull()
    expect(sessions[1]?.sessionPath).toBe(env.sessionFilePath)
  })

  it("returns a parsed transcript for an existing session", async () => {
    const transcript = await service.sessions.getTranscript(env.existingSessionId, {
      includeCommentary: false,
      includeDiffs: true
    })

    expect(transcript.threadName).toBe("Highlights regression")
    expect(transcript.markdown).toContain("### Diffs")
    expect(transcript.lastAssistantMarkdown).toBe(
      "I found two issues in the same carousel and patched both."
    )
  })

  it("surfaces missing session files as null paths in the list", async () => {
    const sessions = await service.sessions.list()
    const missingSession = sessions.find(session => session.id === env.missingSessionId)

    expect(missingSession?.sessionPath).toBeNull()
  })

  it("emits a selected-session-changed event when the watched session file changes", async () => {
    await service.startWatching()
    await service.sessions.getTranscript(env.existingSessionId, {
      includeCommentary: false,
      includeDiffs: true
    })

    const eventPromise = waitForStateChange(service, "selected-session-changed")
    await fs.appendFile(env.sessionFilePath, "\n")
    await expect(eventPromise).resolves.toMatchObject({
      reason: "selected-session-changed",
      changedPath: env.sessionFilePath
    })
  })

  it("emits a manual-refresh event through the app api", async () => {
    await expect(service.app.refresh()).resolves.toMatchObject({
      reason: "manual-refresh"
    })
  })
})
