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

  it("forwards selector ipc calls to the selector service", async () => {
    const ipcMain = createIpcMainStub()
    const selectorService = {
      app: {
        getStateInfo: vi.fn().mockResolvedValue({ stateDir: "/tmp/selector" }),
        openPath: vi.fn().mockResolvedValue({ path: "/tmp/demo.ts" }),
        refresh: vi.fn().mockResolvedValue({ reason: "manual-refresh" })
      },
      roots: {
        list: vi.fn().mockResolvedValue([{ id: "app", path: "/tmp/app", exists: true }])
      },
      git: {
        diffStats: vi.fn().mockResolvedValue({}),
        status: vi.fn().mockResolvedValue({})
      },
      manifests: {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ name: "alpha" }),
        addFiles: vi.fn().mockResolvedValue({ name: "alpha" }),
        duplicate: vi.fn().mockResolvedValue({ name: "alpha-copy" }),
        deleteBundle: vi.fn().mockResolvedValue({ deleted: true }),
        rename: vi.fn().mockResolvedValue({ name: "beta" }),
        setComment: vi.fn().mockResolvedValue({ name: "alpha" }),
        setExportText: vi.fn().mockResolvedValue({ name: "alpha" }),
        setSelected: vi.fn().mockResolvedValue({ name: "alpha" }),
        setSelectedPaths: vi.fn().mockResolvedValue({ name: "alpha" }),
        removeFiles: vi.fn().mockResolvedValue({ name: "alpha" })
      },
      files: {
        search: vi.fn().mockResolvedValue({ files: [] }),
        preview: vi.fn().mockResolvedValue({ path: "/tmp/demo.ts", content: "", truncated: false })
      },
      exports: {
        estimate: vi.fn().mockResolvedValue({ estimated_tokens: 0, selected_count: 0, skipped_files: [] }),
        regenerateAndCopy: vi.fn().mockResolvedValue({ output_path: "/tmp/out.txt", estimated_tokens: 0, file_count: 0, skipped_files: [], copied_to_clipboard: true })
      }
    }
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
      selector: selectorService,
      startWatching: vi.fn(),
      onStateChanged: vi.fn(),
      onSearchStatusChanged: vi.fn(),
      dispose: vi.fn()
    } as any

    registerIpcHandlers(ipcMain as any, service)

    await ipcMain.invoke(IPC_CHANNELS.selector.app.getStateInfo)
    await ipcMain.invoke(IPC_CHANNELS.selector.app.openPath, "/tmp/demo.ts")
    await ipcMain.invoke(IPC_CHANNELS.selector.manifests.addFiles, "alpha", ["/tmp/demo.ts"])
    await ipcMain.invoke(IPC_CHANNELS.selector.files.search, "app", "demo", 20)
    await ipcMain.invoke(IPC_CHANNELS.selector.exports.regenerateAndCopy, "alpha")

    expect(selectorService.app.getStateInfo).toHaveBeenCalled()
    expect(selectorService.app.openPath).toHaveBeenCalledWith("/tmp/demo.ts")
    expect(selectorService.manifests.addFiles).toHaveBeenCalledWith("alpha", ["/tmp/demo.ts"])
    expect(selectorService.files.search).toHaveBeenCalledWith("app", "demo", 20)
    expect(selectorService.exports.regenerateAndCopy).toHaveBeenCalledWith("alpha")
  })

  it("forwards bridge ipc calls to the bridge service", async () => {
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
      bridge: {
        getStatus: vi.fn().mockResolvedValue({ status: "ready" }),
        getConfigSnippets: vi.fn().mockResolvedValue({
          codexCommand: "codex mcp add handoff-agent-bridge -- ...",
          claudeConfigJson: "{}"
        }),
        listRuns: vi.fn().mockResolvedValue([]),
        getRun: vi.fn().mockResolvedValue(null),
        cancelRun: vi.fn().mockResolvedValue(null)
      },
      skills: {
        getStatus: vi.fn().mockResolvedValue({ skillName: "handoff-agent-bridge" }),
        install: vi.fn().mockResolvedValue({ skillName: "handoff-agent-bridge" }),
        exportPackage: vi.fn().mockResolvedValue({ exportPath: "/tmp/export" }),
        getSetupInstructions: vi.fn().mockResolvedValue("manual setup")
      },
      sessions: {
        list: vi.fn(),
        getTranscript: vi.fn()
      },
      search: {
        getStatus: vi.fn(),
        query: vi.fn()
      },
      selector: {
        app: {
          getStateInfo: vi.fn(),
          openPath: vi.fn(),
          refresh: vi.fn(),
          onStateChanged: vi.fn()
        },
        roots: { list: vi.fn() },
        git: { diffStats: vi.fn(), status: vi.fn() },
        manifests: {
          list: vi.fn(),
          get: vi.fn(),
          addFiles: vi.fn(),
          duplicate: vi.fn(),
          deleteBundle: vi.fn(),
          rename: vi.fn(),
          setComment: vi.fn(),
          setExportText: vi.fn(),
          setSelected: vi.fn(),
          setSelectedPaths: vi.fn(),
          removeFiles: vi.fn()
        },
        files: { search: vi.fn(), preview: vi.fn() },
        exports: { estimate: vi.fn(), regenerateAndCopy: vi.fn() }
      },
      startWatching: vi.fn(),
      onStateChanged: vi.fn(),
      onSearchStatusChanged: vi.fn(),
      dispose: vi.fn()
    } as any

    registerIpcHandlers(ipcMain as any, service)

    await ipcMain.invoke(IPC_CHANNELS.bridge.getStatus)
    await ipcMain.invoke(IPC_CHANNELS.bridge.getConfigSnippets)
    await ipcMain.invoke(IPC_CHANNELS.bridge.listRuns, "agent-1", 25)
    await ipcMain.invoke(IPC_CHANNELS.bridge.getRun, "run-1")
    await ipcMain.invoke(IPC_CHANNELS.bridge.cancelRun, "run-2")
    await ipcMain.invoke(IPC_CHANNELS.skills.getStatus)
    await ipcMain.invoke(IPC_CHANNELS.skills.install, "both")
    await ipcMain.invoke(IPC_CHANNELS.skills.exportPackage)
    await ipcMain.invoke(IPC_CHANNELS.skills.copySetupInstructions, "claude")

    expect(service.bridge.getStatus).toHaveBeenCalled()
    expect(service.bridge.getConfigSnippets).toHaveBeenCalled()
    expect(service.bridge.listRuns).toHaveBeenCalledWith("agent-1", 25)
    expect(service.bridge.getRun).toHaveBeenCalledWith("run-1")
    expect(service.bridge.cancelRun).toHaveBeenCalledWith("run-2")
    expect(service.skills.getStatus).toHaveBeenCalled()
    expect(service.skills.install).toHaveBeenCalledWith("both")
    expect(service.skills.exportPackage).toHaveBeenCalled()
    expect(service.skills.getSetupInstructions).toHaveBeenCalledWith("claude")
  })
})
