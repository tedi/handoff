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
  it("treats PreCompact as running", () => {
    expect(
      classifyLiveThreadStatusFromHook({
        eventName: "PreCompact",
        payload: {}
      })
    ).toBe("running")
  })

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
  it("builds a compacting preview for Claude PreCompact hooks", () => {
    const event = buildNormalizedHookEvent({
      provider: "claude",
      eventName: "PreCompact",
      payload: {
        session_id: "claude-live-compact",
        cwd: "/Users/tedikonda/topchallenger/apps/client"
      }
    })

    expect(event).toMatchObject({
      status: "running",
      lastUserPreview: null,
      lastAssistantPreview: "Compacting context...",
      assistantPreviewKind: "compacting"
    })
  })

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

  it("suppresses internal Codex title-generator helper sessions and only shows the real forked conversation", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-control-center-"))
    tempDirs.push(baseDir)

    const service = createControlCenterService({
      dataDir: path.join(baseDir, "user-data")
    })

    await service.startWatching()

    await service.ingestHookEvent({
      id: "codex:helper-1",
      provider: "codex",
      sourceSessionId: "helper-1",
      eventName: "SessionStart",
      eventAt: "2026-04-08T01:31:04.000Z",
      threadName: null,
      projectPath: "/Users/tedikonda/ai/handoff",
      transcriptPath: null,
      status: "running",
      lastUserPreview: null,
      lastAssistantPreview: null,
      assistantPreviewKind: "none",
      launchMode: "app",
      hostAppLabel: "Codex.app",
      hostAppExact: true,
      pendingRequest: null
    })

    expect((await service.getSnapshot()).records).toHaveLength(0)

    await service.ingestHookEvent({
      id: "codex:helper-1",
      provider: "codex",
      sourceSessionId: "helper-1",
      eventName: "UserPromptSubmit",
      eventAt: "2026-04-08T01:31:05.000Z",
      threadName: null,
      projectPath: "/Users/tedikonda/ai/handoff",
      transcriptPath: null,
      status: "running",
      lastUserPreview:
        "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from the prompt.",
      lastAssistantPreview: null,
      assistantPreviewKind: "none",
      launchMode: "app",
      hostAppLabel: "Codex.app",
      hostAppExact: true,
      pendingRequest: null
    })

    await service.ingestHookEvent({
      id: "codex:helper-1",
      provider: "codex",
      sourceSessionId: "helper-1",
      eventName: "Stop",
      eventAt: "2026-04-08T01:31:06.000Z",
      threadName: "Codex conversation",
      projectPath: "/Users/tedikonda/ai/handoff",
      transcriptPath: null,
      status: "completed",
      lastUserPreview: null,
      lastAssistantPreview: "{\"title\":\"Find real-time thread updates\"}",
      assistantPreviewKind: "message",
      launchMode: "app",
      hostAppLabel: "Codex.app",
      hostAppExact: true,
      pendingRequest: null
    })

    expect((await service.getSnapshot()).records).toHaveLength(0)

    await service.ingestHookEvent({
      id: "codex:helper-2",
      provider: "codex",
      sourceSessionId: "helper-2",
      eventName: "Stop",
      eventAt: "2026-04-08T01:31:07.000Z",
      threadName: "Codex conversation",
      projectPath: "/Users/tedikonda/ai/handoff",
      transcriptPath: null,
      status: "completed",
      lastUserPreview: null,
      lastAssistantPreview: "{\"title\":\"Investigate real-time threads\"}",
      assistantPreviewKind: "message",
      launchMode: "app",
      hostAppLabel: "Codex.app",
      hostAppExact: true,
      pendingRequest: null
    })

    expect((await service.getSnapshot()).records).toHaveLength(0)

    await service.ingestHookEvent({
      id: "codex:real-1",
      provider: "codex",
      sourceSessionId: "real-1",
      eventName: "UserPromptSubmit",
      eventAt: "2026-04-08T01:33:35.000Z",
      threadName: "Find real-time thread updates",
      projectPath: "/Users/tedikonda/ai/handoff",
      transcriptPath: null,
      status: "running",
      lastUserPreview: "i just confirmed, when i sent the message it opened a third item on our list.",
      lastAssistantPreview: null,
      assistantPreviewKind: "none",
      launchMode: "app",
      hostAppLabel: "Codex.app",
      hostAppExact: true,
      pendingRequest: null
    })

    const snapshot = await service.getSnapshot()
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]).toMatchObject({
      id: "codex:real-1",
      threadName: "Find real-time thread updates",
      lastUserPreview:
        "i just confirmed, when i sent the message it opened a third item on our list."
    })

    await service.dispose()
  })

  it("reconciles stale Claude running state back to completed after compact meta entries", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-control-center-"))
    tempDirs.push(baseDir)

    const transcriptPath = path.join(baseDir, "claude-compact.jsonl")
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-04-08T03:30:00.000Z",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Finished the change." }],
            stop_reason: "end_turn"
          }
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-08T03:34:39.120Z",
          message: {
            role: "user",
            content:
              "<command-name>/compact</command-name>\n<command-message>compact</command-message>"
          }
        })
      ].join("\n"),
      "utf8"
    )

    const service = createControlCenterService({
      dataDir: path.join(baseDir, "user-data")
    })

    await service.startWatching()
    await service.reconcileSessions([
      {
        id: "claude:claude-compact-1",
        sourceSessionId: "claude-compact-1",
        provider: "claude",
        archived: false,
        threadName: "Claude compact test",
        createdAt: "2026-04-08T03:30:00.000Z",
        updatedAt: "2026-04-08T03:34:39.193Z",
        projectPath: "/tmp/project",
        sessionPath: transcriptPath
      }
    ])

    await service.ingestHookEvent({
      id: "claude:claude-compact-1",
      provider: "claude",
      sourceSessionId: "claude-compact-1",
      eventName: "PreCompact",
      eventAt: "2026-04-08T03:34:39.050Z",
      threadName: "Claude compact test",
      projectPath: "/tmp/project",
      transcriptPath,
      status: "running",
      lastUserPreview: null,
      lastAssistantPreview: "Update file.ts",
      assistantPreviewKind: "thinking",
      launchMode: "cli",
      hostAppLabel: "Ghostty",
      hostAppExact: true,
      pendingRequest: null
    })

    let snapshot = await service.getSnapshot()
    expect(snapshot.records[0]).toMatchObject({
      status: "running",
      lastUserPreview: null,
      lastAssistantPreview: "Compacting context...",
      assistantPreviewKind: "compacting"
    })

    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-04-08T03:30:00.000Z",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Finished the change." }],
            stop_reason: "end_turn"
          }
        }),
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          timestamp: "2026-04-08T03:34:39.087Z"
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-08T03:34:39.120Z",
          message: {
            role: "user",
            content:
              "<command-name>/compact</command-name>\n<command-message>compact</command-message>"
          }
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-08T03:34:39.193Z",
          message: {
            role: "user",
            content:
              "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>"
          }
        })
      ].join("\n"),
      "utf8"
    )

    await new Promise(resolve => setTimeout(resolve, 150))

    snapshot = await service.getSnapshot()
    expect(snapshot.records[0]).toMatchObject({
      status: "completed",
      lastUserPreview: null,
      lastAssistantPreview: "Conversation compacted",
      assistantPreviewKind: "compacted"
    })

    await service.dispose()
  })

  it("does not demote an existing Claude row on a blank SessionStart", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-control-center-"))
    tempDirs.push(baseDir)

    const transcriptPath = path.join(baseDir, "claude-session-start.jsonl")
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-04-08T04:00:00.000Z",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Completed work." }],
            stop_reason: "end_turn"
          }
        })
      ].join("\n"),
      "utf8"
    )

    const service = createControlCenterService({
      dataDir: path.join(baseDir, "user-data")
    })

    await service.startWatching()
    await service.ingestHookEvent({
      id: "claude:resume-1",
      provider: "claude",
      sourceSessionId: "resume-1",
      eventName: "Stop",
      eventAt: "2026-04-08T04:00:01.000Z",
      threadName: "Resume test",
      projectPath: "/tmp/project",
      transcriptPath,
      status: "completed",
      lastUserPreview: null,
      lastAssistantPreview: "Completed work.",
      assistantPreviewKind: "message",
      launchMode: "cli",
      hostAppLabel: "Ghostty",
      hostAppExact: true,
      pendingRequest: null
    })

    let snapshot = await service.getSnapshot()
    expect(snapshot.records[0]).toMatchObject({
      status: "completed",
      lastAssistantPreview: "Completed work.",
      assistantPreviewKind: "message"
    })

    await service.ingestHookEvent({
      id: "claude:resume-1",
      provider: "claude",
      sourceSessionId: "resume-1",
      eventName: "SessionStart",
      eventAt: "2026-04-08T04:02:00.000Z",
      threadName: null,
      projectPath: "/tmp/project",
      transcriptPath: null,
      status: "running",
      lastUserPreview: null,
      lastAssistantPreview: null,
      assistantPreviewKind: "none",
      launchMode: "cli",
      hostAppLabel: "Ghostty",
      hostAppExact: true,
      pendingRequest: null
    })

    snapshot = await service.getSnapshot()
    expect(snapshot.records[0]).toMatchObject({
      status: "completed",
      lastAssistantPreview: "Completed work.",
      assistantPreviewKind: "message"
    })

    await service.dispose()
  })

  it("marks a blank CLI SessionStart as ready", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-control-center-"))
    tempDirs.push(baseDir)

    const service = createControlCenterService({
      dataDir: path.join(baseDir, "user-data")
    })

    await service.startWatching()
    await service.ingestHookEvent({
      id: "claude:ready-1",
      provider: "claude",
      sourceSessionId: "ready-1",
      eventName: "SessionStart",
      eventAt: "2026-04-10T03:00:00.000Z",
      threadName: "Claude conversation",
      projectPath: "/tmp/project",
      transcriptPath: null,
      status: "running",
      lastUserPreview: null,
      lastAssistantPreview: null,
      assistantPreviewKind: "none",
      launchMode: "cli",
      hostAppLabel: "Ghostty",
      hostAppExact: true,
      pendingRequest: null
    })

    const snapshot = await service.getSnapshot()
    expect(snapshot.records[0]).toMatchObject({
      status: "ready",
      lastUserPreview: null,
      lastAssistantPreview: null,
      assistantPreviewKind: "none"
    })

    await service.dispose()
  })

  it("removes an active Claude CLI row on SessionEnd", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-control-center-"))
    tempDirs.push(baseDir)

    const service = createControlCenterService({
      dataDir: path.join(baseDir, "user-data")
    })

    await service.startWatching()
    await service.ingestHookEvent({
      id: "claude:end-1",
      provider: "claude",
      sourceSessionId: "end-1",
      eventName: "SessionStart",
      eventAt: "2026-04-10T03:00:00.000Z",
      threadName: "Claude conversation",
      projectPath: "/tmp/project",
      transcriptPath: null,
      status: "running",
      lastUserPreview: null,
      lastAssistantPreview: null,
      assistantPreviewKind: "none",
      launchMode: "cli",
      hostAppLabel: "Ghostty",
      hostAppExact: true,
      pendingRequest: null
    })

    expect((await service.getSnapshot()).records).toHaveLength(1)

    await service.ingestHookEvent({
      id: "claude:end-1",
      provider: "claude",
      sourceSessionId: "end-1",
      eventName: "SessionEnd",
      eventAt: "2026-04-10T03:00:10.000Z",
      threadName: null,
      projectPath: "/tmp/project",
      transcriptPath: null,
      status: "completed",
      lastUserPreview: null,
      lastAssistantPreview: null,
      assistantPreviewKind: "none",
      launchMode: "cli",
      hostAppLabel: "Ghostty",
      hostAppExact: true,
      pendingRequest: null
    })

    expect((await service.getSnapshot()).records).toHaveLength(0)

    await service.dispose()
  })

  it("suppresses Claude compact continuation shell sessions with no real activity", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-control-center-"))
    tempDirs.push(baseDir)

    const transcriptPath = path.join(baseDir, "claude-continuation-shell.jsonl")
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          timestamp: "2026-04-08T04:16:06.147Z"
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-08T04:16:06.148Z",
          message: {
            role: "user",
            content:
              "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nNo explicit user request has been made yet."
          }
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-08T04:16:06.248Z",
          message: {
            role: "user",
            content:
              "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>"
          }
        })
      ].join("\n"),
      "utf8"
    )

    const service = createControlCenterService({
      dataDir: path.join(baseDir, "user-data")
    })

    await service.startWatching()
    await service.ingestHookEvent({
      id: "claude:continuation-shell-1",
      provider: "claude",
      sourceSessionId: "continuation-shell-1",
      eventName: "PreCompact",
      eventAt: "2026-04-08T04:16:06.120Z",
      threadName: "Claude conversation",
      projectPath: "/tmp/project",
      transcriptPath,
      status: "running",
      lastUserPreview: null,
      lastAssistantPreview: "Compacting context...",
      assistantPreviewKind: "compacting",
      launchMode: "cli",
      hostAppLabel: "Ghostty",
      hostAppExact: true,
      pendingRequest: null
    })

    await new Promise(resolve => setTimeout(resolve, 1500))

    expect((await service.getSnapshot()).records).toHaveLength(0)

    await service.dispose()
  })
})
