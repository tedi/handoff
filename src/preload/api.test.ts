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
    await bridge.sessions.getTranscript("session-1", {
      includeCommentary: false,
      includeDiffs: true
    })
    await bridge.clipboard.writeText("copied")

    expect(invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.sessions.list)
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.sessions.getTranscript,
      "session-1",
      {
        includeCommentary: false,
        includeDiffs: true
      }
    )
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      IPC_CHANNELS.clipboard.writeText,
      "copied"
    )
  })
})
