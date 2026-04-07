import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  buildNormalizedHookEvent,
  classifyLiveThreadStatusFromHook,
  createControlCenterService
} from "./control-center"

describe("classifyLiveThreadStatusFromHook", () => {
  it("treats ambiguous Stop events as completed", () => {
    expect(
      classifyLiveThreadStatusFromHook({
        eventName: "Stop",
        payload: {}
      })
    ).toBe("completed")
  })

  it("keeps waiting-user only for explicit input-needed signals", () => {
    expect(
      classifyLiveThreadStatusFromHook({
        eventName: "Stop",
        payload: {
          reason: "waiting for your input"
        }
      })
    ).toBe("waiting_user")
  })
})

describe("buildNormalizedHookEvent", () => {
  it("builds a structured Claude permission request card from PermissionRequest hooks", () => {
    const event = buildNormalizedHookEvent({
      provider: "claude",
      eventName: "PermissionRequest",
      payload: {
        session_id: "claude-live-1",
        cwd: "/Users/tedikonda/topchallenger/apps/client",
        tool_name: "Edit",
        tool_input: {
          file_path: "src/auth/middleware.ts",
          old_string: "jwt.verify(token);",
          new_string: "if (!token) throw new AuthError('missing');"
        },
        permission_suggestions: [
          {
            type: "addRules",
            behavior: "allow",
            destination: "session",
            rules: [{ toolName: "Edit" }]
          }
        ]
      }
    })

    expect(event.pendingRequest).toMatchObject({
      type: "approval_request",
      title: "Permission Request",
      actionability: "inline",
      actions: [
        { label: "Deny" },
        { label: "Allow" },
        { label: "Allow for session" }
      ]
    })
    expect(event.pendingRequest?.preview).toMatchObject({
      type: "diff",
      target: "src/auth/middleware.ts"
    })
  })

  it("builds a structured Claude choice request card from AskUserQuestion", () => {
    const event = buildNormalizedHookEvent({
      provider: "claude",
      eventName: "PreToolUse",
      payload: {
        session_id: "claude-live-2",
        cwd: "/Users/tedikonda/topchallenger/apps/client",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              header: "Deploy target",
              question: "Which deployment target?",
              options: [{ label: "Production" }, { label: "Staging" }],
              multiSelect: false
            }
          ]
        }
      }
    })

    expect(event.pendingRequest).toMatchObject({
      type: "choice_request",
      title: "Deploy target",
      prompt: "Which deployment target?",
      actionability: "inline",
      actions: [
        { label: "Production", acceleratorHint: "1" },
        { label: "Staging", acceleratorHint: "2" }
      ]
    })
  })
})

describe("createControlCenterService", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))
    )
  })

  it("reconciles live hook events with transcript previews and plays sound on reply-needed transitions", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-control-center-"))
    tempDirs.push(baseDir)

    const transcriptPath = path.join(baseDir, "live-1.jsonl")
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: "2026-03-14T02:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "live-1",
            cwd: "/Users/tedikonda/topchallenger/apps/client",
            originator: "Codex Desktop",
            source: "vscode"
          }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T02:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1"
          }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Please implement the plan."
              }
            ]
          }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T02:00:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [
              {
                type: "output_text",
                text: "Inspecting the codebase."
              }
            ]
          }
        }),
        JSON.stringify({
          timestamp: "2026-03-14T02:00:04.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [
              {
                type: "output_text",
                text: "Implemented the Control Center flow."
              }
            ]
          }
        })
      ].join("\n"),
      "utf8"
    )

    const playSound = vi.fn()
    const service = createControlCenterService({
      dataDir: path.join(baseDir, "user-data"),
      onPlaySound: playSound
    })

    await service.startWatching()
    await service.reconcileSessions([
      {
        id: "codex:live-1",
        sourceSessionId: "live-1",
        provider: "codex",
        archived: false,
        threadName: "Control Center live thread",
        createdAt: "2026-03-14T02:00:00.000Z",
        updatedAt: "2026-03-14T02:00:04.000Z",
        projectPath: "/Users/tedikonda/topchallenger/apps/client",
        sessionPath: transcriptPath
      }
    ])

    await service.ingestHookEvent({
      id: "codex:live-1",
      provider: "codex",
      sourceSessionId: "live-1",
      eventName: "SessionStart",
      eventAt: "2026-03-14T02:00:01.000Z",
      threadName: null,
      projectPath: "/Users/tedikonda/topchallenger/apps/client",
      transcriptPath,
      status: "running",
      lastUserPreview: null,
      lastAssistantPreview: null,
      assistantPreviewKind: "none",
      launchMode: "app",
      hostAppLabel: null,
      hostAppExact: false,
      pendingRequest: null
    })

    let snapshot = await service.getSnapshot()
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]).toMatchObject({
      id: "codex:live-1",
      threadName: "Control Center live thread",
      lastUserPreview: "Please implement the plan.",
      lastAssistantPreview: "Inspecting the codebase.",
      assistantPreviewKind: "thinking",
      launchMode: "app",
      hostAppLabel: "Codex.app",
      hostAppExact: true
    })
    expect(playSound).not.toHaveBeenCalled()

    await service.ingestHookEvent({
      id: "codex:live-1",
      provider: "codex",
      sourceSessionId: "live-1",
      eventName: "Stop",
      eventAt: "2026-03-14T02:00:05.000Z",
      threadName: null,
      projectPath: "/Users/tedikonda/topchallenger/apps/client",
      transcriptPath,
      status: "waiting_user",
      lastUserPreview: null,
      lastAssistantPreview: "Implemented the Control Center flow.",
      assistantPreviewKind: "message",
      launchMode: "app",
      hostAppLabel: null,
      hostAppExact: false,
      pendingRequest: null
    })

    snapshot = await service.getSnapshot()
    expect(snapshot.records[0]).toMatchObject({
      status: "waiting_user",
      lastAssistantPreview: "Implemented the Control Center flow.",
      assistantPreviewKind: "message"
    })
    expect(playSound).toHaveBeenCalledTimes(1)

    await service.dismiss("codex:live-1")
    expect((await service.getSnapshot()).records).toHaveLength(0)

    await service.dispose()
  })
})
