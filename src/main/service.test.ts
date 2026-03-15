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
  claudeHome: string
  codexExistingId: string
  codexArchivedId: string
  codexFilteredId: string
  codexSessionFilePath: string
  codexArchivedSessionFilePath: string
  claudeIndexedId: string
  claudeIndexedSessionPath: string
  claudeFallbackId: string
  claudeFallbackSessionPath: string
  claudeIndexPath: string
}

async function loadFixture(name: string) {
  return fs.readFile(
    path.join(__dirname, "../shared/test/fixtures", name),
    "utf8"
  )
}

function buildClaudeSession(params: {
  sessionId: string
  cwd: string
  prompt: string
  interimText?: string
  finalText: string
  patchFilePath?: string
}) {
  const records: string[] = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-03-14T00:20:00.000Z",
      cwd: params.cwd,
      sessionId: params.sessionId,
      isSidechain: false,
      message: {
        role: "user",
        content: [{ type: "text", text: params.prompt }]
      }
    })
  ]

  if (params.interimText) {
    records.push(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-03-14T00:20:01.000Z",
        cwd: params.cwd,
        sessionId: params.sessionId,
        isSidechain: false,
        message: {
          model: "claude-opus-4-6",
          role: "assistant",
          content: [{ type: "text", text: params.interimText }],
          stop_reason: null
        }
      })
    )
  }

  if (params.patchFilePath) {
    records.push(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-03-14T00:20:02.000Z",
        cwd: params.cwd,
        sessionId: params.sessionId,
        isSidechain: false,
        message: {
          model: "claude-opus-4-6",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `tool-${params.sessionId}`,
              name: "Edit",
              input: { file_path: params.patchFilePath }
            }
          ],
          stop_reason: "tool_use"
        }
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-14T00:20:03.000Z",
        cwd: params.cwd,
        sessionId: params.sessionId,
        isSidechain: false,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `tool-${params.sessionId}` }]
        },
        toolUseResult: {
          filePath: params.patchFilePath,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-const value = 1", "+const value = 2"]
            }
          ],
          originalFile: "const value = 1"
        }
      })
    )
  }

  records.push(
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-03-14T00:20:04.000Z",
      cwd: params.cwd,
      sessionId: params.sessionId,
        isSidechain: false,
        message: {
          model: "claude-opus-4-6",
          role: "assistant",
          content: [{ type: "text", text: params.finalText }],
          stop_reason: "end_turn"
        }
      })
  )

  return records.join("\n")
}

async function createTestEnvironment(): Promise<TestEnvironment> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-app-"))
  const appDir = path.join(baseDir, "app")
  const codexHome = path.join(baseDir, ".codex")
  const claudeHome = path.join(baseDir, ".claude")
  const sessionsDir = path.join(codexHome, "sessions", "2026", "03", "14")
  const archivedSessionsDir = path.join(codexHome, "archived_sessions")
  const claudeIndexedProjectDir = path.join(
    claudeHome,
    "projects",
    "-Users-tedikonda-topchallenger-apps"
  )
  const claudeFallbackProjectDir = path.join(
    claudeHome,
    "projects",
    "-Users-tedikonda-ai-handoff"
  )

  const codexExistingId = "019ce9aa-04f8-7860-883a-1ceb41b9ac31"
  const codexArchivedId = "019ce9aa-04f8-7860-883a-1ceb41b9ac32"
  const codexFilteredId = "019ce9aa-04f8-7860-883a-1ceb41b9ac33"
  const claudeIndexedId = "9a728c6c-c2df-4570-871e-217aac26a29c"
  const claudeFallbackId = "7f5d8b1d-4b9b-45c2-93d8-87323df5d4ea"

  const codexSessionFilePath = path.join(
    sessionsDir,
    `rollout-2026-03-13T17-05-59-${codexExistingId}.jsonl`
  )
  const codexArchivedSessionFilePath = path.join(
    archivedSessionsDir,
    `rollout-2026-03-13T17-06-59-${codexArchivedId}.jsonl`
  )
  const claudeIndexedSessionPath = path.join(
    claudeIndexedProjectDir,
    `${claudeIndexedId}.jsonl`
  )
  const claudeFallbackSessionPath = path.join(
    claudeFallbackProjectDir,
    `${claudeFallbackId}.jsonl`
  )
  const claudeMistakeSessionPath = path.join(
    claudeFallbackProjectDir,
    "mistake-session.jsonl"
  )
  const claudeIndexPath = path.join(claudeIndexedProjectDir, "sessions-index.json")

  await fs.mkdir(appDir, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })
  await fs.mkdir(archivedSessionsDir, { recursive: true })
  await fs.mkdir(claudeIndexedProjectDir, { recursive: true })
  await fs.mkdir(path.join(claudeFallbackProjectDir, "subagents"), { recursive: true })
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    ['model = "gpt-5.4"', 'model_reasoning_effort = "xhigh"', 'service_tier = "fast"'].join(
      "\n"
    )
  )
  await fs.writeFile(
    path.join(claudeHome, "settings.json"),
    JSON.stringify(
      {
        effortLevel: "high",
        alwaysThinkingEnabled: true
      },
      null,
      2
    )
  )
  await fs.writeFile(
    path.join(codexHome, "session_index.jsonl"),
    [
      JSON.stringify({
        id: codexExistingId,
        thread_name: "Older highlights title",
        updated_at: "2026-03-14T00:17:45.474Z"
      }),
      JSON.stringify({
        id: codexArchivedId,
        thread_name: "Archived Codex session",
        updated_at: "2026-03-14T00:19:45.474Z"
      }),
      JSON.stringify({
        id: codexFilteredId,
        thread_name: "Filtered missing Codex session",
        updated_at: "2026-03-14T00:19:15.474Z"
      }),
      JSON.stringify({
        id: codexExistingId,
        thread_name: "Highlights regression",
        updated_at: "2026-03-14T00:18:45.474Z"
      })
    ].join("\n")
  )
  await fs.writeFile(
    codexSessionFilePath,
    [
      JSON.stringify({
        timestamp: "2026-03-14T00:08:49.033Z",
        type: "session_meta",
        payload: {
          id: codexExistingId,
          timestamp: "2026-03-14T00:05:59.676Z",
          cwd: "/Users/tedikonda/topchallenger/apps/client",
          originator: "Codex Desktop",
          source: "vscode"
        }
      }),
      await loadFixture("sample-session.jsonl")
    ].join("\n")
  )
  await fs.writeFile(
    codexArchivedSessionFilePath,
    [
      JSON.stringify({
        timestamp: "2026-03-14T00:09:49.033Z",
        type: "session_meta",
        payload: {
          id: codexArchivedId,
          timestamp: "2026-03-14T00:06:59.676Z",
          cwd: "/Users/tedikonda/topchallenger/apps",
          originator: "Codex Desktop",
          source: "vscode"
        }
      }),
      await loadFixture("sample-session.jsonl")
    ].join("\n")
  )

  await fs.writeFile(
    claudeIndexedSessionPath,
    buildClaudeSession({
      sessionId: claudeIndexedId,
      cwd: "/Users/tedikonda/topchallenger/apps",
      prompt: "Review the merged handoff UI",
      interimText: "Let me inspect the changed files.",
      finalText: "All 17 tests pass.",
      patchFilePath: "/Users/tedikonda/ai/handoff/src/renderer/App.tsx"
    })
  )
  await fs.writeFile(
    claudeIndexPath,
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            sessionId: claudeIndexedId,
            fullPath: claudeIndexedSessionPath,
            summary: "Claude indexed session",
            firstPrompt: "No prompt",
            modified: "2026-03-14T00:21:00.000Z",
            projectPath: "/Users/tedikonda/topchallenger/apps",
            isSidechain: false
          },
          {
            sessionId: "subagent-session",
            fullPath: path.join(claudeIndexedProjectDir, "subagent-session.jsonl"),
            summary: "Should not appear",
            modified: "2026-03-14T00:22:00.000Z",
            projectPath: "/Users/tedikonda/topchallenger/apps",
            isSidechain: true
          }
        ]
      },
      null,
      2
    )
  )

  await fs.writeFile(
    claudeFallbackSessionPath,
    buildClaudeSession({
      sessionId: claudeFallbackId,
      cwd: "/Users/tedikonda/ai/handoff",
      prompt: "Fallback Claude session",
      interimText: "Checking current layout.",
      finalText: "Fallback done."
    })
  )
  await fs.writeFile(
    claudeMistakeSessionPath,
    [
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-14T00:22:00.000Z",
        cwd: "/Users/tedikonda/ai/handoff",
        sessionId: "mistake-session",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<command-name>/plugin</command-name>\n<command-message>plugin</command-message>"
            }
          ]
        }
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-14T00:22:01.000Z",
        cwd: "/Users/tedikonda/ai/handoff",
        sessionId: "mistake-session",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Unknown skill: react-native-ease-refactor"
            }
          ]
        }
      })
    ].join("\n")
  )
  await fs.writeFile(
    path.join(claudeFallbackProjectDir, "subagents", "ignored.jsonl"),
    buildClaudeSession({
      sessionId: "ignored-subagent",
      cwd: "/Users/tedikonda/ai/handoff",
      prompt: "Ignored subagent",
      finalText: "Should never be listed."
    })
  )

  return {
    appDir,
    baseDir,
    codexHome,
    claudeHome,
    codexExistingId,
    codexArchivedId,
    codexFilteredId,
    codexSessionFilePath,
    codexArchivedSessionFilePath,
    claudeIndexedId,
    claudeIndexedSessionPath,
    claudeFallbackId,
    claudeFallbackSessionPath,
    claudeIndexPath
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

async function waitForSelectorStateChange(
  service: ReturnType<typeof createHandoffService>,
  reason: string
) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for selector ${reason}.`))
    }, 2000)

    const unsubscribe = service.onSelectorStateChanged(event => {
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
      codexHome: env.codexHome,
      claudeHome: env.claudeHome
    })
  })

  afterEach(async () => {
    await service.dispose()
    await fs.rm(env.baseDir, { recursive: true, force: true })
  })

  it("merges Codex and Claude sessions newest-first, prefers Claude index metadata, and resolves paths", async () => {
    const sessions = await service.sessions.list()

    expect(sessions.map(session => session.id)).toEqual([
      `claude:${env.claudeIndexedId}`,
      `claude:${env.claudeFallbackId}`,
      `codex:${env.codexArchivedId}`,
      `codex:${env.codexExistingId}`
    ])
    expect(sessions.map(session => session.threadName)).toEqual([
      "Claude indexed session",
      "Fallback Claude session",
      "Archived Codex session",
      "Highlights regression"
    ])
    expect(
      sessions.some(session => session.id === "claude:mistake-session")
    ).toBe(false)
    expect(
      sessions.some(session => session.id === `codex:${env.codexFilteredId}`)
    ).toBe(false)
    expect(sessions[0]).toMatchObject({
      provider: "claude",
      projectPath: "/Users/tedikonda/topchallenger/apps",
      sessionPath: env.claudeIndexedSessionPath
    })
    expect(sessions[1]).toMatchObject({
      provider: "claude",
      projectPath: "/Users/tedikonda/ai/handoff",
      sessionPath: env.claudeFallbackSessionPath
    })
    expect(sessions[2]).toMatchObject({
      provider: "codex",
      archived: true,
      projectPath: "/Users/tedikonda/topchallenger/apps",
      sessionPath: env.codexArchivedSessionFilePath
    })
    expect(sessions[3]).toMatchObject({
      provider: "codex",
      archived: false,
      projectPath: "/Users/tedikonda/topchallenger/apps/client",
      sessionPath: env.codexSessionFilePath
    })
  })

  it("returns a parsed transcript for a Claude session using the shared transcript model", async () => {
    const transcript = await service.sessions.getTranscript(`claude:${env.claudeIndexedId}`, {
      includeCommentary: false,
      includeDiffs: true
    })

    expect(transcript.provider).toBe("claude")
    expect(transcript.threadName).toBe("Claude indexed session")
    expect(transcript.projectPath).toBe("/Users/tedikonda/topchallenger/apps")
    expect(transcript.sessionClient).toBe("cli")
    expect(transcript.markdown).toContain("All 17 tests pass.")
    expect(transcript.markdown).toContain("### Diffs")
    expect(transcript.entries.map(entry => entry.kind)).toEqual([
      "message",
      "thought_chain",
      "message"
    ])
  })

  it("loads archived Codex sessions through the normal transcript path", async () => {
    const transcript = await service.sessions.getTranscript(`codex:${env.codexArchivedId}`, {
      includeCommentary: false,
      includeDiffs: true
    })

    expect(transcript.provider).toBe("codex")
    expect(transcript.archived).toBe(true)
    expect(transcript.sessionPath).toBe(env.codexArchivedSessionFilePath)
    expect(transcript.threadName).toBe("Archived Codex session")
    expect(transcript.markdown).toContain("### Diffs")
  })

  it("emits a selected-session-changed event when the watched Claude session file changes", async () => {
    await service.startWatching()
    await service.sessions.getTranscript(`claude:${env.claudeIndexedId}`, {
      includeCommentary: false,
      includeDiffs: true
    })
    await new Promise(resolve => setTimeout(resolve, 150))

    const eventPromise = waitForStateChange(service, "selected-session-changed")
    await fs.appendFile(env.claudeIndexedSessionPath, "\n")
    await expect(eventPromise).resolves.toMatchObject({
      reason: "selected-session-changed",
      changedPath: env.claudeIndexedSessionPath
    })
  })

  it("emits an index-changed event when the Codex session index changes", async () => {
    await service.startWatching()
    await new Promise(resolve => setTimeout(resolve, 150))

    const eventPromise = waitForStateChange(service, "index-changed")
    await fs.appendFile(path.join(env.codexHome, "session_index.jsonl"), "\n")

    await expect(eventPromise).resolves.toMatchObject({
      reason: "index-changed",
      changedPath: path.join(env.codexHome, "session_index.jsonl")
    })
  })

  it("emits a manual-refresh event through the app api", async () => {
    await expect(service.app.refresh()).resolves.toMatchObject({
      reason: "manual-refresh"
    })
  })

  it("exposes selector state info, roots, manifests, and file search through the shared service", async () => {
    await service.dispose()

    const selectorStateDir = path.join(env.baseDir, "selector-state")
    const selectorProjectDir = path.join(env.baseDir, "selector-project")
    const selectorFilePath = path.join(selectorProjectDir, "src", "alpha.ts")

    await fs.mkdir(path.dirname(selectorFilePath), { recursive: true })
    await fs.writeFile(selectorFilePath, "export const alpha = 1\n")
    await fs.mkdir(path.join(selectorStateDir, "manifests"), { recursive: true })
    await fs.writeFile(
      path.join(selectorStateDir, "config.json"),
      JSON.stringify(
        {
          roots: [
            {
              id: "handoff",
              path: selectorProjectDir
            }
          ]
        },
        null,
        2
      )
    )
    await fs.writeFile(
      path.join(selectorStateDir, "manifests", "alpha.json"),
      JSON.stringify(
        {
          name: "alpha",
          created_at: "2026-03-14T00:00:00.000Z",
          updated_at: "2026-03-14T00:05:00.000Z",
          files: [
            {
              path: selectorFilePath,
              relative_path: "src/alpha.ts",
              root_id: "handoff",
              comment: "Important file",
              selected: true
            }
          ],
          export_prefix_text: "prefix",
          export_suffix_text: "suffix",
          strip_comments: false,
          git_diff_mode: "off",
          use_git_diffs: false
        },
        null,
        2
      )
    )

    service = createHandoffService({
      appDir: env.appDir,
      codexHome: env.codexHome,
      claudeHome: env.claudeHome,
      selectorStateDir
    })

    await expect(service.selector.app.getStateInfo()).resolves.toMatchObject({
      stateDir: selectorStateDir,
      configPath: path.join(selectorStateDir, "config.json"),
      manifestsDir: path.join(selectorStateDir, "manifests"),
      exportsDir: path.join(selectorStateDir, "exports")
    })
    await expect(service.selector.roots.list()).resolves.toEqual([
      {
        id: "handoff",
        path: selectorProjectDir,
        exists: true
      }
    ])
    await expect(service.selector.manifests.list()).resolves.toMatchObject([
      {
        name: "alpha",
        file_count: 1
      }
    ])
    await expect(service.selector.manifests.get("alpha")).resolves.toMatchObject({
      name: "alpha",
      file_count: 1,
      files: [
        expect.objectContaining({
          path: selectorFilePath,
          relative_path: "src/alpha.ts",
          comment: "Important file"
        })
      ]
    })
    await expect(service.selector.files.search("handoff", "alpha", 20)).resolves.toMatchObject({
      files: [
        expect.objectContaining({
          path: selectorFilePath,
          relative_path: "src/alpha.ts"
        })
      ]
    })
  })

  it("emits selector watcher updates when manifests change", async () => {
    await service.dispose()

    const selectorStateDir = path.join(env.baseDir, "selector-watch-state")
    await fs.mkdir(path.join(selectorStateDir, "manifests"), { recursive: true })
    await fs.writeFile(
      path.join(selectorStateDir, "config.json"),
      JSON.stringify({ roots: [] }, null, 2)
    )

    service = createHandoffService({
      appDir: env.appDir,
      codexHome: env.codexHome,
      claudeHome: env.claudeHome,
      selectorStateDir
    })

    await service.startWatching()
    await new Promise(resolve => setTimeout(resolve, 150))

    const eventPromise = waitForSelectorStateChange(service, "manifests-changed")
    await fs.writeFile(
      path.join(selectorStateDir, "manifests", "watch.json"),
      JSON.stringify(
        {
          name: "watch",
          created_at: "2026-03-14T00:00:00.000Z",
          updated_at: "2026-03-14T00:01:00.000Z",
          files: [],
          export_prefix_text: null,
          export_suffix_text: null,
          strip_comments: false,
          git_diff_mode: "off",
          use_git_diffs: false
        },
        null,
        2
      )
    )

    await expect(eventPromise).resolves.toMatchObject({
      reason: "manifests-changed",
      changedPath: path.join(selectorStateDir, "manifests", "watch.json")
    })
  })

  it("reads provider config info and terminal defaults from local settings", async () => {
    const snapshot = await service.settings.get()

    expect(snapshot.settings.providers.codex).toEqual({
      binaryPath: "",
      homePath: ""
    })
    expect(snapshot.providerInfo.codex).toMatchObject({
      effectiveBinaryPath: "codex",
      effectiveHomePath: env.codexHome,
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
      serviceTier: "fast"
    })
    expect(snapshot.providerInfo.claude).toMatchObject({
      effectiveBinaryPath: "claude",
      effectiveHomePath: env.claudeHome,
      effortLevel: "high",
      alwaysThinkingEnabled: true,
      observedModel: "claude-opus-4-6"
    })
    expect(snapshot.terminalOptions.map(option => option.id)).toEqual([
      "terminal",
      "ghostty",
      "warp"
    ])
    expect(snapshot.settings.terminals.enabledTerminalIds).toContain("terminal")
  })

  it("persists settings overrides and resetProvider clears only the selected provider", async () => {
    const customCodexHome = path.join(env.baseDir, "custom-codex")
    const customClaudeHome = path.join(env.baseDir, "custom-claude")
    await fs.mkdir(customCodexHome, { recursive: true })
    await fs.mkdir(customClaudeHome, { recursive: true })
    await fs.writeFile(
      path.join(customCodexHome, "config.toml"),
      ['model = "gpt-5.5"', 'model_reasoning_effort = "high"', 'service_tier = "priority"'].join(
        "\n"
      )
    )
    await fs.writeFile(
      path.join(customClaudeHome, "settings.json"),
      JSON.stringify(
        {
          effortLevel: "max",
          alwaysThinkingEnabled: false
        },
        null,
        2
      )
    )

    const updated = await service.settings.update({
      providers: {
        codex: {
          binaryPath: "/custom/bin/codex",
          homePath: customCodexHome
        },
        claude: {
          binaryPath: "/custom/bin/claude",
          homePath: customClaudeHome
        }
      },
      terminals: {
        enabledTerminalIds: ["terminal", "ghostty"],
        defaultTerminalId: "ghostty"
      }
    })

    expect(updated.providerInfo.codex).toMatchObject({
      effectiveBinaryPath: "/custom/bin/codex",
      effectiveHomePath: customCodexHome,
      model: "gpt-5.5"
    })
    expect(updated.providerInfo.claude).toMatchObject({
      effectiveBinaryPath: "/custom/bin/claude",
      effectiveHomePath: customClaudeHome,
      effortLevel: "max",
      alwaysThinkingEnabled: false
    })
    expect(updated.settings.terminals).toEqual({
      enabledTerminalIds: ["terminal", "ghostty"],
      defaultTerminalId: "ghostty"
    })

    const reset = await service.settings.resetProvider("claude")

    expect(reset.settings.providers.codex).toEqual({
      binaryPath: "/custom/bin/codex",
      homePath: customCodexHome
    })
    expect(reset.settings.providers.claude).toEqual({
      binaryPath: "",
      homePath: ""
    })
  })

  it("creates, updates, duplicates, and deletes persisted agents", async () => {
    expect(await service.agents.list()).toEqual([])

    const createdAgent = await service.agents.create()
    expect(createdAgent).toMatchObject({
      name: "New agent",
      provider: "codex",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
      fast: false,
      customInstructions: ""
    })

    const updatedAgent = await service.agents.update(createdAgent.id, {
      name: "Claude reviewer",
      provider: "claude",
      modelId: "gpt-5.4",
      thinkingLevel: "max",
      fast: true,
      customInstructions: "Review carefully."
    })

    expect(updatedAgent).toMatchObject({
      name: "Claude reviewer",
      provider: "claude",
      modelId: "sonnet",
      thinkingLevel: "max",
      fast: false,
      customInstructions: "Review carefully."
    })

    const duplicatedAgent = await service.agents.duplicate(updatedAgent.id)
    expect(duplicatedAgent).toMatchObject({
      name: "Claude reviewer copy",
      provider: "claude",
      modelId: "sonnet"
    })

    await expect(
      service.agents.update(updatedAgent.id, {
        name: "   "
      })
    ).rejects.toThrow("Agent name is required.")

    await expect(service.agents.delete(updatedAgent.id)).resolves.toEqual({
      deletedId: updatedAgent.id
    })

    const remainingAgents = await service.agents.list()
    expect(remainingAgents).toHaveLength(1)
    expect(remainingAgents[0]?.id).toBe(duplicatedAgent.id)

    const snapshot = await service.settings.get()
    expect(snapshot.settings.agents).toHaveLength(1)
    expect(snapshot.settings.agents[0]?.name).toBe("Claude reviewer copy")
  })
})
