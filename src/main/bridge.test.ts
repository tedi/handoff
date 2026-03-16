import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentDefinition, HandoffSettings } from "../shared/contracts"
import {
  createAgentBridgeService,
  AgentBridgeBusyError,
  runAgentBridgeWorkerJob
} from "./bridge"

interface BridgeTestContext {
  baseDir: string
  dataDir: string
  codexHome: string
  claudeHome: string
  projectPath: string
}

async function createBridgeTestContext(): Promise<BridgeTestContext> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-bridge-"))
  const dataDir = path.join(baseDir, "user-data")
  const codexHome = path.join(baseDir, ".codex")
  const claudeHome = path.join(baseDir, ".claude")
  const projectPath = path.join(baseDir, "project")

  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(codexHome, { recursive: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.mkdir(projectPath, { recursive: true })

  return {
    baseDir,
    dataDir,
    codexHome,
    claudeHome,
    projectPath
  }
}

async function writeSettings(
  dataDir: string,
  agents: AgentDefinition[]
) {
  const settings: HandoffSettings = {
    providers: {
      codex: {
        binaryPath: "",
        homePath: ""
      },
      claude: {
        binaryPath: "",
        homePath: ""
      }
    },
    terminals: {
      enabledTerminalIds: ["terminal"],
      defaultTerminalId: "terminal"
    },
    agents
  }

  await fs.writeFile(
    path.join(dataDir, "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8"
  )
}

describe("createAgentBridgeService", () => {
  let context: BridgeTestContext | null = null

  afterEach(async () => {
    vi.restoreAllMocks()

    if (context) {
      await fs.rm(context.baseDir, { recursive: true, force: true })
      context = null
    }
  })

  it("builds and executes a Codex agent run and persists history", async () => {
    context = await createBridgeTestContext()
    await writeSettings(context.dataDir, [
      {
        id: "agent-codex",
        name: "Codex reviewer",
        provider: "codex",
        modelId: "gpt-5.4",
        thinkingLevel: "max",
        fast: true,
        timeoutSec: null,
        customInstructions: "Review code carefully."
      }
    ])

    const executeCommand = vi.fn().mockImplementation(async params => {
      const outputPathIndex = params.args.indexOf("-o")
      const outputPath = params.args[outputPathIndex + 1]
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, "Codex final answer", "utf8")

      return {
        stdout: JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "ignored" }] } }),
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false
      }
    })

    const bridge = createAgentBridgeService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      bridgeCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-mcp"]
      },
      executeCommand
    })

    const result = await bridge.askAgent({
      agentId: "agent-codex",
      message: "How should I refactor this module?",
      projectPath: context.projectPath,
      caller: "claude-code"
    })

    expect(result.status).toBe("completed")
    expect(result.answer).toBe("Codex final answer")

    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex",
        cwd: context.projectPath,
        env: expect.objectContaining({
          CODEX_HOME: context.codexHome
        }),
        stdin: expect.stringContaining("How should I refactor this module?"),
        timeoutMs: null
      })
    )
    expect(executeCommand.mock.calls[0]?.[0].args).toEqual(
      expect.arrayContaining([
        "exec",
        "--json",
        "--ephemeral",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        context.projectPath,
        "--model",
        "gpt-5.4",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-c",
        'service_tier="fast"'
      ])
    )

    const runs = await bridge.listRuns("agent-codex")
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      runId: result.runId,
      status: "completed",
      answer: "Codex final answer",
      message: "How should I refactor this module?"
    })
    expect(await bridge.getRun(result.runId)).toMatchObject({
      runId: result.runId,
      status: "completed"
    })
  })

  it("builds and executes a Claude agent run with JSON output parsing", async () => {
    context = await createBridgeTestContext()
    await fs.writeFile(
      path.join(context.claudeHome, "settings.json"),
      JSON.stringify({ effortLevel: "high" }, null, 2),
      "utf8"
    )
    await writeSettings(context.dataDir, [
      {
        id: "agent-claude",
        name: "Claude explainer",
        provider: "claude",
        modelId: "sonnet",
        thinkingLevel: "max",
        fast: false,
        timeoutSec: null,
        customInstructions: "Be concise."
      }
    ])

    const executeCommand = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        result: "Claude final answer"
      }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false
    })

    const bridge = createAgentBridgeService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      bridgeCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-mcp"]
      },
      executeCommand
    })

    const result = await bridge.askAgent({
      agentName: "Claude explainer",
      message: "Summarize the current branch status.",
      projectPath: context.projectPath,
      context: "Repo is mid-refactor."
    })

    expect(result.answer).toBe("Claude final answer")
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "claude",
        cwd: context.projectPath,
        timeoutMs: null
      })
    )
    expect(executeCommand.mock.calls[0]?.[0].args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "sonnet",
        "--effort",
        "max",
        "--settings",
        path.join(context.claudeHome, "settings.json")
      ])
    )
  })

  it("ignores caller-provided timeoutSec and uses the saved agent timeout", async () => {
    context = await createBridgeTestContext()
    await writeSettings(context.dataDir, [
      {
        id: "agent-timeout",
        name: "Timeout agent",
        provider: "codex",
        modelId: "gpt-5.4",
        thinkingLevel: "high",
        fast: false,
        timeoutSec: null,
        customInstructions: ""
      }
    ])

    const executeCommand = vi.fn().mockImplementation(async params => {
      const outputPathIndex = params.args.indexOf("-o")
      const outputPath = params.args[outputPathIndex + 1]
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, "No timeout override", "utf8")

      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false
      }
    })

    const bridge = createAgentBridgeService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      bridgeCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-mcp"]
      },
      executeCommand
    })

    await bridge.askAgent({
      agentId: "agent-timeout",
      message: "Check timeout precedence.",
      projectPath: context.projectPath,
      timeoutSec: 120
    })

    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: null
      })
    )
  })

  it("starts async runs immediately and completes them through the detached worker flow", async () => {
    context = await createBridgeTestContext()
    await writeSettings(context.dataDir, [
      {
        id: "agent-async",
        name: "Async agent",
        provider: "codex",
        modelId: "gpt-5.4",
        thinkingLevel: "high",
        fast: false,
        timeoutSec: null,
        customInstructions: "Answer carefully."
      }
    ])

    const executeCommand = vi.fn().mockImplementation(async params => {
      const outputPathIndex = params.args.indexOf("-o")
      const outputPath = params.args[outputPathIndex + 1]
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, "Async final answer", "utf8")

      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false
      }
    })

    const spawnWorkerProcess = vi.fn().mockResolvedValue(process.pid)
    const bridge = createAgentBridgeService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      bridgeCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-mcp"]
      },
      spawnWorkerProcess
    })

    const started = await bridge.startRun({
      agentId: "agent-async",
      message: "Handle this asynchronously.",
      projectPath: context.projectPath
    })

    expect(started.status).toBe("running")
    expect(spawnWorkerProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-worker"],
        runId: started.runId
      })
    )

    expect(await bridge.getRun(started.runId)).toMatchObject({
      runId: started.runId,
      status: "running",
      workerPid: process.pid
    })

    const currentContext = context
    if (!currentContext) {
      throw new Error("Missing bridge test context.")
    }

    const workerPromise = new Promise<void>(resolve => {
      setTimeout(() => {
        void runAgentBridgeWorkerJob({
          dataDir: currentContext.dataDir,
          runId: started.runId,
          executeCommand
        }).then(() => resolve())
      }, 50)
    })

    expect(await bridge.waitForRun(started.runId, 1)).toMatchObject({
      runId: started.runId,
      status: "completed",
      answer: "Async final answer"
    })
    await workerPromise
  })

  it("cancels async runs and preserves the canceled state", async () => {
    context = await createBridgeTestContext()
    await writeSettings(context.dataDir, [
      {
        id: "agent-cancel",
        name: "Cancelable agent",
        provider: "codex",
        modelId: "gpt-5.4",
        thinkingLevel: "high",
        fast: false,
        timeoutSec: null,
        customInstructions: ""
      }
    ])

    const dummyWorker = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
      stdio: "ignore"
    })

    try {
      const bridge = createAgentBridgeService({
        dataDir: context.dataDir,
        codexHome: context.codexHome,
        claudeHome: context.claudeHome,
        bridgeCommand: {
          command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
          args: ["--agent-bridge-mcp"]
        },
        spawnWorkerProcess: vi.fn().mockResolvedValue(dummyWorker.pid ?? null)
      })

      const started = await bridge.startRun({
        agentId: "agent-cancel",
        message: "Cancel this run.",
        projectPath: context.projectPath
      })

      const canceled = await bridge.cancelRun(started.runId)
      expect(canceled).toMatchObject({
        runId: started.runId,
        status: "canceled",
        error: "Run canceled."
      })
    } finally {
      dummyWorker.kill("SIGKILL")
    }
  })

  it("enforces one active run per agent with a cross-process lock", async () => {
    context = await createBridgeTestContext()
    await writeSettings(context.dataDir, [
      {
        id: "agent-busy",
        name: "Busy agent",
        provider: "codex",
        modelId: "gpt-5.4",
        thinkingLevel: "high",
        fast: false,
        timeoutSec: null,
        customInstructions: ""
      }
    ])

    let releaseExecution: (() => void) | null = null
    const executeCommand = vi.fn().mockImplementation(
      async params =>
        new Promise(resolve => {
          const outputPathIndex = params.args.indexOf("-o")
          const outputPath = params.args[outputPathIndex + 1]

          releaseExecution = () => {
            void fs.mkdir(path.dirname(outputPath), { recursive: true })
              .then(() => fs.writeFile(outputPath, "Busy answer", "utf8"))
              .then(() =>
                resolve({
                  stdout: "",
                  stderr: "",
                  exitCode: 0,
                  signal: null,
                  timedOut: false
                })
              )
          }
        })
    )

    const bridge = createAgentBridgeService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      bridgeCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-mcp"]
      },
      executeCommand
    })

    const firstRunPromise = bridge.askAgent({
      agentId: "agent-busy",
      message: "First request",
      projectPath: context.projectPath
    })

    await vi.waitFor(() => {
      expect(executeCommand).toHaveBeenCalledTimes(1)
    })

    const secondRunPromise = bridge.askAgent({
      agentId: "agent-busy",
      message: "Second request",
      projectPath: context.projectPath
    })

    await expect(secondRunPromise).rejects.toBeInstanceOf(AgentBridgeBusyError)

    const resolveExecution = releaseExecution as (() => void) | null
    if (resolveExecution) {
      resolveExecution()
    }
    await firstRunPromise
  })

  it("builds bridge config snippets for Codex and Claude", async () => {
    context = await createBridgeTestContext()
    await writeSettings(context.dataDir, [])

    const bridge = createAgentBridgeService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      bridgeCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-mcp"]
      }
    })

    const snippets = await bridge.getConfigSnippets()
    expect(snippets.codexCommand).toContain("codex mcp add handoff-agent-bridge --")
    expect(snippets.claudeConfigJson).toContain('"handoff-agent-bridge"')
    expect(snippets.claudeConfigJson).toContain('"command": "/Applications/Handoff.app/Contents/MacOS/Handoff"')
  })
})
