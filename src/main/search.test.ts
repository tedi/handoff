import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { SessionListItem } from "../shared/contracts"
import { createHandoffSearchService } from "./search"

class FakeEmbedder {
  async embed(text: string) {
    const normalized = text.toLowerCase()
    return [
      normalized.includes("gesture") ? 1 : 0,
      normalized.includes("archived") ? 1 : 0,
      normalized.includes("filter") ? 1 : 0
    ]
  }
}

function buildCodexSession(params: {
  cwd: string
  userText: string
  assistantText: string
}) {
  return [
    JSON.stringify({
      timestamp: "2026-03-14T01:00:00.000Z",
      type: "session_meta",
      payload: {
        cwd: params.cwd,
        source: "cli",
        originator: "codex_cli_rs"
      }
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-03-14T01:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: params.userText
      }
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-03-14T01:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: params.assistantText
      }
    })
  ].join("\n")
}

const tempDirs: string[] = []

async function createSessionFile(fileName: string, content: string) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-search-"))
  tempDirs.push(baseDir)
  const filePath = path.join(baseDir, fileName)
  await fs.writeFile(filePath, content, "utf8")
  return filePath
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(directory =>
      fs.rm(directory, { recursive: true, force: true })
    )
  )
})

describe("createHandoffSearchService", () => {
  it("writes weighted markdown documents and builds a ready index", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-search-data-"))
    tempDirs.push(dataDir)
    const sessionPath = await createSessionFile(
      "gesture.jsonl",
      buildCodexSession({
        cwd: "/tmp/project",
        userText: "Gesture swipe broke after the upgrade.",
        assistantText: "I found the issue in highlights.tsx."
      })
    )

    const service = createHandoffSearchService({
      dataDir,
      embedder: new FakeEmbedder()
    })

    const sessions: SessionListItem[] = [
      {
        id: "codex:gesture",
        sourceSessionId: "gesture",
        provider: "codex",
        archived: false,
        threadName: "Gesture regression",
        createdAt: "2026-03-13T23:50:00.000Z",
        updatedAt: "2026-03-14T01:00:00.000Z",
        projectPath: "/tmp/project",
        sessionPath
      }
    ]

    await service.syncSessions(sessions)

    const status = await service.getStatus()
    expect(status.state).toBe("ready")
    expect(status.documentCount).toBe(1)

    const writtenMarkdown = await fs.readFile(
      path.join(dataDir, "search", "documents", "codex%3Agesture.md"),
      "utf8"
    )

    expect(writtenMarkdown).toContain("# Gesture regression")
    expect(writtenMarkdown.match(/Gesture regression/g)?.length).toBeGreaterThanOrEqual(2)
    expect(writtenMarkdown).toContain("Gesture swipe broke after the upgrade.")

    await service.dispose()
  })

  it("returns filtered semantic thread results", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-search-data-"))
    tempDirs.push(dataDir)
    const gestureSessionPath = await createSessionFile(
      "gesture.jsonl",
      buildCodexSession({
        cwd: "/tmp/project",
        userText: "Gesture swipe broke after the upgrade.",
        assistantText: "I found the issue in highlights.tsx."
      })
    )
    const archivedSessionPath = await createSessionFile(
      "archived.jsonl",
      buildCodexSession({
        cwd: "/tmp/archive-project",
        userText: "Archived cleanup thread.",
        assistantText: "Archived answer."
      })
    )

    const service = createHandoffSearchService({
      dataDir,
      embedder: new FakeEmbedder()
    })

    await service.syncSessions([
      {
        id: "codex:gesture",
        sourceSessionId: "gesture",
        provider: "codex",
        archived: false,
        threadName: "Gesture regression",
        createdAt: "2026-03-13T23:50:00.000Z",
        updatedAt: "2026-03-14T01:00:00.000Z",
        projectPath: "/tmp/project",
        sessionPath: gestureSessionPath
      },
      {
        id: "codex:archived",
        sourceSessionId: "archived",
        provider: "codex",
        archived: true,
        threadName: "Archived maintenance",
        createdAt: "2026-03-12T23:50:00.000Z",
        updatedAt: "2026-03-13T01:00:00.000Z",
        projectPath: "/tmp/archive-project",
        sessionPath: archivedSessionPath
      }
    ])

    const gestureResults = await service.query({
      query: "gesture swipe",
      filters: {
        archived: "all",
        provider: "all",
        projectPaths: [],
        dateRange: "all"
      },
      limit: 10
    })
    expect(gestureResults[0]?.id).toBe("codex:gesture")

    const archivedResults = await service.query({
      query: "",
      filters: {
        archived: "archived",
        provider: "all",
        projectPaths: [],
        dateRange: "all"
      },
      limit: 10
    })
    expect(archivedResults).toHaveLength(1)
    expect(archivedResults[0]?.id).toBe("codex:archived")

    const projectResults = await service.query({
      query: "",
      filters: {
        archived: "all",
        provider: "all",
        projectPaths: ["/tmp/project"],
        dateRange: "all"
      },
      limit: 10
    })
    expect(projectResults).toHaveLength(1)
    expect(projectResults[0]?.id).toBe("codex:gesture")

    await service.dispose()
  })
})
