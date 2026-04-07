import { describe, expect, it } from "vitest"

import {
  pickGhosttySurfaceForThread,
  type GhosttySurfaceInfo
} from "./terminal"

describe("pickGhosttySurfaceForThread", () => {
  it("prefers the existing Ghostty surface that matches the live session id and title", () => {
    const surfaces: GhosttySurfaceInfo[] = [
      {
        windowId: "window-1",
        windowName: "zsh",
        tabId: "tab-1",
        tabName: "zsh",
        terminalId: "terminal-1",
        terminalName: "zsh",
        workingDirectory: "/Users/tedikonda/topchallenger/apps/server"
      },
      {
        windowId: "window-2",
        windowName: "client · I just added @app/screens/onbo · 129cdc2d-2781-44",
        tabId: "tab-2",
        tabName: "client · I just added @app/screens/onbo · 129cdc2d-2781-44",
        terminalId: "terminal-2",
        terminalName: "client · I just added @app/screens/onbo · 129cdc2d-2781-44",
        workingDirectory: "/Users/tedikonda/topchallenger/apps/client"
      }
    ]

    const surface = pickGhosttySurfaceForThread({
      surfaces,
      sessionId: "129cdc2d-2781-44bf-90c2-d11fd90c4600",
      threadName: "I just added @app/screens/onbo",
      projectPath: "/Users/tedikonda/topchallenger/apps/client"
    })

    expect(surface?.terminalId).toBe("terminal-2")
  })

  it("ignores the shared Ghostty window title when choosing between tabs in the same window", () => {
    const surfaces: GhosttySurfaceInfo[] = [
      {
        windowId: "window-1",
        windowName: "client · Investigate live focus · 129cdc2d-2781-44",
        tabId: "tab-1",
        tabName: "client · older thread",
        terminalId: "terminal-1",
        terminalName: "client · older thread",
        workingDirectory: "/Users/tedikonda/topchallenger/apps/client"
      },
      {
        windowId: "window-1",
        windowName: "client · Investigate live focus · 129cdc2d-2781-44",
        tabId: "tab-2",
        tabName: "client · Investigate live focus · 129cdc2d-2781-44",
        terminalId: "terminal-2",
        terminalName: "client · Investigate live focus · 129cdc2d-2781-44",
        workingDirectory: "/Users/tedikonda/topchallenger/apps/client"
      }
    ]

    const surface = pickGhosttySurfaceForThread({
      surfaces,
      sessionId: "129cdc2d-2781-44bf-90c2-d11fd90c4600",
      threadName: "Investigate live focus",
      projectPath: "/Users/tedikonda/topchallenger/apps/client"
    })

    expect(surface?.tabId).toBe("tab-2")
  })

  it("refuses generic Ghostty shells that only share the cwd", () => {
    const surfaces: GhosttySurfaceInfo[] = [
      {
        windowId: "window-1",
        windowName: "zsh",
        tabId: "tab-1",
        tabName: "zsh",
        terminalId: "terminal-1",
        terminalName: "zsh",
        workingDirectory: "/Users/tedikonda/topchallenger/apps/client"
      }
    ]

    const surface = pickGhosttySurfaceForThread({
      surfaces,
      sessionId: "129cdc2d-2781-44bf-90c2-d11fd90c4600",
      threadName: "I just added @app/screens/onbo",
      projectPath: "/Users/tedikonda/topchallenger/apps/client"
    })

    expect(surface).toBeNull()
  })
})
