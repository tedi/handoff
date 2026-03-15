import { afterEach, describe, expect, it, vi } from "vitest"
import os from "node:os"

import { IPC_CHANNELS } from "../shared/channels"
import type { HandoffSettingsSnapshot } from "../shared/contracts"

const terminalMocks = vi.hoisted(() => ({
  openShellCommandInTerminal: vi.fn().mockResolvedValue({ fallbackMessage: null }),
  openProjectInTerminal: vi.fn().mockResolvedValue({ fallbackMessage: null }),
  buildCodexResumeCommand: vi.fn().mockReturnValue("codex-launch-command"),
  buildClaudeResumeCommand: vi.fn().mockReturnValue("claude-launch-command"),
  buildCodexStartCommand: vi.fn().mockReturnValue("codex-start-command"),
  buildClaudeStartCommand: vi.fn().mockReturnValue("claude-start-command")
}))

vi.mock("electron", () => ({
  clipboard: {
    writeText: vi.fn()
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => true,
      resize() {
        return {
          toDataURL: () => null
        }
      }
    }))
  },
  shell: {
    openPath: vi.fn().mockResolvedValue(""),
    openExternal: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock("./terminal", () => ({
  openShellCommandInTerminal: terminalMocks.openShellCommandInTerminal,
  openProjectInTerminal: terminalMocks.openProjectInTerminal,
  buildCodexResumeCommand: terminalMocks.buildCodexResumeCommand,
  buildClaudeResumeCommand: terminalMocks.buildClaudeResumeCommand,
  buildCodexStartCommand: terminalMocks.buildCodexStartCommand,
  buildClaudeStartCommand: terminalMocks.buildClaudeStartCommand
}))

import { registerIpcHandlers } from "./ipc"

function createIpcMainStub() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  return {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    },
    invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel)
      if (!handler) {
        throw new Error(`No handler registered for ${channel}`)
      }

      return handler({}, ...args)
    }
  }
}

const settingsSnapshot: HandoffSettingsSnapshot = {
  settings: {
    providers: {
      codex: {
        binaryPath: "/custom/bin/codex",
        homePath: "/custom/.codex"
      },
      claude: {
        binaryPath: "/custom/bin/claude",
        homePath: "/custom/.claude"
      }
    },
    terminals: {
      enabledTerminalIds: ["terminal", "ghostty"],
      defaultTerminalId: "ghostty"
    },
    agents: []
  },
  providerInfo: {
    codex: {
      provider: "codex",
      binarySource: "override",
      effectiveBinaryPath: "/custom/bin/codex",
      homeSource: "override",
      effectiveHomePath: "/custom/.codex",
      configPath: "/custom/.codex/config.toml",
      configExists: true,
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      effortLevel: null,
      alwaysThinkingEnabled: null,
      observedModel: null
    },
    claude: {
      provider: "claude",
      binarySource: "override",
      effectiveBinaryPath: "/custom/bin/claude",
      homeSource: "override",
      effectiveHomePath: "/custom/.claude",
      configPath: "/custom/.claude/settings.json",
      configExists: true,
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      effortLevel: "high",
      alwaysThinkingEnabled: true,
      observedModel: "claude-opus-4-6"
    }
  },
  terminalOptions: [
    { id: "terminal", label: "Terminal", installed: true },
    { id: "ghostty", label: "Ghostty", installed: true },
    { id: "warp", label: "Warp", installed: false }
  ]
}

describe("registerIpcHandlers", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("uses the selected default terminal for Codex and Claude CLI launches", async () => {
    const ipcMain = createIpcMainStub()
    const service = {
      app: {
        getStateInfo: vi.fn(),
        refresh: vi.fn()
      },
      settings: {
        get: vi.fn().mockResolvedValue(settingsSnapshot),
        update: vi.fn(),
        resetProvider: vi.fn()
      },
      agents: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        duplicate: vi.fn()
      },
      sessions: {
        list: vi.fn(),
        getTranscript: vi.fn()
      },
      search: {
        getStatus: vi.fn(),
        query: vi.fn()
      },
      startWatching: vi.fn(),
      onStateChanged: vi.fn(),
      onSearchStatusChanged: vi.fn(),
      dispose: vi.fn()
    } as any

    registerIpcHandlers(ipcMain as any, service)

    await ipcMain.invoke(
      IPC_CHANNELS.app.openSourceSession,
      "codex",
      "session-1",
      "cli",
      "/tmp/project"
    )
    await ipcMain.invoke(
      IPC_CHANNELS.app.openSourceSession,
      "claude",
      "session-2",
      "cli",
      "/tmp/claude-project"
    )

    expect(terminalMocks.buildCodexResumeCommand).toHaveBeenCalledWith({
      sessionId: "session-1",
      sessionCwd: "/tmp/project",
      binaryPath: "/custom/bin/codex",
      homePath: "/custom/.codex"
    })
    expect(terminalMocks.buildClaudeResumeCommand).toHaveBeenCalledWith({
      sessionId: "session-2",
      workingDirectory: "/tmp/claude-project",
      binaryPath: "/custom/bin/claude",
      settingsPath: "/custom/.claude/settings.json"
    })
    expect(terminalMocks.openShellCommandInTerminal).toHaveBeenNthCalledWith(1, {
      preferredTerminalId: "ghostty",
      command: "codex-launch-command"
    })
    expect(terminalMocks.openShellCommandInTerminal).toHaveBeenNthCalledWith(2, {
      preferredTerminalId: "ghostty",
      command: "claude-launch-command"
    })
  })

  it("uses the selected default terminal for project terminal opens", async () => {
    const ipcMain = createIpcMainStub()
    const service = {
      app: {
        getStateInfo: vi.fn(),
        refresh: vi.fn()
      },
      settings: {
        get: vi.fn().mockResolvedValue(settingsSnapshot),
        update: vi.fn(),
        resetProvider: vi.fn()
      },
      agents: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        duplicate: vi.fn()
      },
      sessions: {
        list: vi.fn(),
        getTranscript: vi.fn()
      },
      search: {
        getStatus: vi.fn(),
        query: vi.fn()
      },
      startWatching: vi.fn(),
      onStateChanged: vi.fn(),
      onSearchStatusChanged: vi.fn(),
      dispose: vi.fn()
    } as any

    registerIpcHandlers(ipcMain as any, service)

    await ipcMain.invoke(
      IPC_CHANNELS.app.openProjectPath,
      "terminal",
      os.tmpdir()
    )

    expect(terminalMocks.openProjectInTerminal).toHaveBeenCalledWith({
      preferredTerminalId: "ghostty",
      projectPath: os.tmpdir()
    })
  })

  it("starts new CLI threads with provider-specific launch options", async () => {
    const ipcMain = createIpcMainStub()
    const service = {
      app: {
        getStateInfo: vi.fn(),
        refresh: vi.fn()
      },
      settings: {
        get: vi.fn().mockResolvedValue(settingsSnapshot),
        update: vi.fn(),
        resetProvider: vi.fn()
      },
      agents: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        duplicate: vi.fn()
      },
      sessions: {
        list: vi.fn(),
        getTranscript: vi.fn()
      },
      search: {
        getStatus: vi.fn(),
        query: vi.fn()
      },
      startWatching: vi.fn(),
      onStateChanged: vi.fn(),
      onSearchStatusChanged: vi.fn(),
      dispose: vi.fn()
    } as any

    registerIpcHandlers(ipcMain as any, service)

    await ipcMain.invoke(IPC_CHANNELS.app.startNewThread, {
      provider: "codex",
      launchMode: "cli",
      modelId: "gpt-5.4",
      projectPath: "/tmp/project",
      prompt: "codex prompt",
      thinkingLevel: "max",
      fast: true
    })

    await ipcMain.invoke(IPC_CHANNELS.app.startNewThread, {
      provider: "claude",
      launchMode: "cli",
      modelId: "sonnet",
      projectPath: "/tmp/claude-project",
      prompt: "claude prompt",
      thinkingLevel: "high",
      fast: false
    })

    expect(terminalMocks.buildCodexStartCommand).toHaveBeenCalledWith({
      projectPath: "/tmp/project",
      prompt: "codex prompt",
      binaryPath: "/custom/bin/codex",
      homePath: "/custom/.codex",
      modelId: "gpt-5.4",
      reasoningEffort: "xhigh",
      serviceTier: "fast"
    })
    expect(terminalMocks.buildClaudeStartCommand).toHaveBeenCalledWith({
      projectPath: "/tmp/claude-project",
      prompt: "claude prompt",
      binaryPath: "/custom/bin/claude",
      settingsPath: "/custom/.claude/settings.json",
      modelId: "sonnet",
      effortLevel: "high"
    })
    expect(terminalMocks.openShellCommandInTerminal).toHaveBeenNthCalledWith(1, {
      preferredTerminalId: "ghostty",
      command: "codex-start-command"
    })
    expect(terminalMocks.openShellCommandInTerminal).toHaveBeenNthCalledWith(2, {
      preferredTerminalId: "ghostty",
      command: "claude-start-command"
    })
  })
})
