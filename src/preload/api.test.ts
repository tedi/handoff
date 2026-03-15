import { describe, expect, it, vi } from "vitest"

import { IPC_CHANNELS } from "../shared/channels"
import { createHandoffBridge } from "./api"

describe("createHandoffBridge", () => {
  it("forwards IPC calls through the preload bridge", async () => {
    const invoke = vi.fn().mockResolvedValue("ok")
    const on = vi.fn()
    const removeListener = vi.fn()
    const bridge = createHandoffBridge({
      invoke,
      on,
      removeListener
    })

    await bridge.sessions.list()
    await bridge.sessions.getTranscript("codex:session-1", {
      includeCommentary: false,
      includeDiffs: true
    })
    await bridge.search.getStatus()
    await bridge.search.query({
      query: "gesture",
      filters: {
        archived: "all",
        provider: "all",
        projectPaths: [],
        dateRange: "all"
      },
      limit: 10
    })
    await bridge.settings.get()
    await bridge.settings.update({
      providers: {
        codex: {
          binaryPath: "/custom/codex"
        }
      }
    })
    await bridge.settings.resetProvider("claude")
    await bridge.agents.list()
    await bridge.agents.create()
    await bridge.agents.update("agent-1", {
      name: "Reviewer"
    })
    await bridge.agents.delete("agent-1")
    await bridge.agents.duplicate("agent-2")
    await bridge.app.openSourceSession("claude", "session-1", "cli", "/tmp/project")
    await bridge.app.startNewThread({
      provider: "codex",
      launchMode: "cli",
      modelId: "gpt-5.4",
      projectPath: "/tmp/project",
      prompt: "hello",
      thinkingLevel: "high",
      fast: true
    })
    await bridge.app.openProjectPath("editor", "/tmp/project")
    await bridge.clipboard.writeText("copied")

    expect(invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.sessions.list)
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.sessions.getTranscript,
      "codex:session-1",
      {
        includeCommentary: false,
        includeDiffs: true
      }
    )
    expect(invoke).toHaveBeenNthCalledWith(3, IPC_CHANNELS.search.getStatus)
    expect(invoke).toHaveBeenNthCalledWith(
      4,
      IPC_CHANNELS.search.query,
      {
        query: "gesture",
        filters: {
          archived: "all",
          provider: "all",
          projectPaths: [],
          dateRange: "all"
        },
        limit: 10
      }
    )
    expect(invoke).toHaveBeenNthCalledWith(
      5,
      IPC_CHANNELS.settings.get
    )
    expect(invoke).toHaveBeenNthCalledWith(
      6,
      IPC_CHANNELS.settings.update,
      {
        providers: {
          codex: {
            binaryPath: "/custom/codex"
          }
        }
      }
    )
    expect(invoke).toHaveBeenNthCalledWith(
      7,
      IPC_CHANNELS.settings.resetProvider,
      "claude"
    )
    expect(invoke).toHaveBeenNthCalledWith(
      8,
      IPC_CHANNELS.agents.list
    )
    expect(invoke).toHaveBeenNthCalledWith(
      9,
      IPC_CHANNELS.agents.create
    )
    expect(invoke).toHaveBeenNthCalledWith(
      10,
      IPC_CHANNELS.agents.update,
      "agent-1",
      {
        name: "Reviewer"
      }
    )
    expect(invoke).toHaveBeenNthCalledWith(
      11,
      IPC_CHANNELS.agents.delete,
      "agent-1"
    )
    expect(invoke).toHaveBeenNthCalledWith(
      12,
      IPC_CHANNELS.agents.duplicate,
      "agent-2"
    )
    expect(invoke).toHaveBeenNthCalledWith(
      13,
      IPC_CHANNELS.app.openSourceSession,
      "claude",
      "session-1",
      "cli",
      "/tmp/project"
    )
    expect(invoke).toHaveBeenNthCalledWith(
      14,
      IPC_CHANNELS.app.startNewThread,
      {
        provider: "codex",
        launchMode: "cli",
        modelId: "gpt-5.4",
        projectPath: "/tmp/project",
        prompt: "hello",
        thinkingLevel: "high",
        fast: true
      }
    )
    expect(invoke).toHaveBeenNthCalledWith(
      15,
      IPC_CHANNELS.app.openProjectPath,
      "editor",
      "/tmp/project"
    )
    expect(invoke).toHaveBeenNthCalledWith(
      16,
      IPC_CHANNELS.clipboard.writeText,
      "copied"
    )
  })
})
