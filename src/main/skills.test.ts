import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  CONTROL_CENTER_CLAUDE_EVENTS,
  CONTROL_CENTER_CODEX_EVENTS
} from "./control-center"
import { createHandoffSkillsService } from "./skills"

interface SkillsTestContext {
  baseDir: string
  dataDir: string
  codexHome: string
  claudeHome: string
}

async function createSkillsTestContext(): Promise<SkillsTestContext> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-skills-"))
  const dataDir = path.join(baseDir, "user-data")
  const codexHome = path.join(baseDir, ".codex")
  const claudeHome = path.join(baseDir, ".claude")

  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(codexHome, { recursive: true })
  await fs.mkdir(claudeHome, { recursive: true })

  return {
    baseDir,
    dataDir,
    codexHome,
    claudeHome
  }
}

describe("createHandoffSkillsService", () => {
  let context: SkillsTestContext | null = null

  afterEach(async () => {
    if (context) {
      await fs.rm(context.baseDir, { recursive: true, force: true })
      context = null
    }
  })

  it("installs Codex and Claude skill wiring idempotently", async () => {
    context = await createSkillsTestContext()
    const skills = createHandoffSkillsService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      bridgeCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-mcp"]
      },
      liveHookCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: []
      }
    })

    const beforeInstall = await skills.getStatus()
    expect(beforeInstall.providers.codex.skillInstalled).toBe(false)
    expect(beforeInstall.providers.claude.skillInstalled).toBe(false)

    const afterInstall = await skills.install("both")
    expect(afterInstall.providers.codex.skillInstalled).toBe(true)
    expect(afterInstall.providers.codex.mcpInstalled).toBe(true)
    expect(afterInstall.providers.codex.liveHooksInstalled).toBe(true)
    expect(afterInstall.providers.claude.skillInstalled).toBe(true)
    expect(afterInstall.providers.claude.mcpInstalled).toBe(true)
    expect(afterInstall.providers.claude.liveHooksInstalled).toBe(true)

    const codexConfig = await fs.readFile(path.join(context.codexHome, "config.toml"), "utf8")
    const codexHooks = JSON.parse(
      await fs.readFile(path.join(context.codexHome, "hooks.json"), "utf8")
    ) as Record<string, unknown>
    const claudeConfig = JSON.parse(
      await fs.readFile(path.join(context.claudeHome, "settings.json"), "utf8")
    ) as Record<string, unknown>

    expect(codexConfig).toContain("# BEGIN HANDOFF SKILLS MANAGED BLOCK")
    expect(codexConfig).toContain('[[skills.config]]')
    expect(codexConfig).toContain('handoff-agent-bridge')
    expect(codexConfig).toContain(
      path.join(context.codexHome, "skills", "handoff-agent-bridge", "SKILL.md")
    )
    expect(codexHooks).toMatchObject({
      hooks: {
        SessionStart: expect.any(Array),
        UserPromptSubmit: expect.any(Array),
        Stop: expect.any(Array)
      }
    })
    expect(claudeConfig).toMatchObject({
      mcpServers: {
        "handoff-agent-bridge": {
          command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
          args: ["--agent-bridge-mcp"]
        }
      },
      hooks: {
        SessionStart: expect.any(Array),
        UserPromptSubmit: expect.any(Array),
        Stop: expect.any(Array)
      }
    })

    await skills.install("both")
    const codexConfigAfterReinstall = await fs.readFile(
      path.join(context.codexHome, "config.toml"),
      "utf8"
    )
    await expect(
      fs.readFile(
        path.join(context.codexHome, "skills", "handoff-agent-bridge", "SKILL.md"),
        "utf8"
      )
    ).resolves.toContain("threadName")
    expect(
      codexConfigAfterReinstall.match(/# BEGIN HANDOFF SKILLS MANAGED BLOCK/g)
    ).toHaveLength(1)
  })

  it("exports portable Codex and Claude skill packages", async () => {
    context = await createSkillsTestContext()
    const skills = createHandoffSkillsService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      bridgeCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-mcp"]
      },
      liveHookCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: []
      }
    })

    const exportResult = await skills.exportPackage()

    await expect(fs.readFile(path.join(exportResult.codexPath, "SKILL.md"), "utf8")).resolves
      .toContain("threadName")
    await expect(
      fs.readFile(path.join(exportResult.codexPath, "agents", "openai.yaml"), "utf8")
    ).resolves.toContain("handoff-agent-bridge")
    await expect(fs.readFile(path.join(exportResult.claudePath, "SKILL.md"), "utf8")).resolves
      .toContain("threadName")
    await expect(fs.readFile(exportResult.claudePluginPath, "utf8")).resolves.toContain(
      "\"handoff-agent-bridge\""
    )
  })

  it("preserves existing provider hooks while merging Handoff live hooks idempotently", async () => {
    context = await createSkillsTestContext()
    await fs.writeFile(
      path.join(context.codexHome, "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    command: "/Users/tedikonda/.vibe-island/bin/vibe-island-bridge --source codex",
                    type: "command"
                  }
                ]
              }
            ],
            Stop: [
              {
                hooks: [
                  {
                    command: "echo custom-codex-stop",
                    type: "command"
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    )
    await fs.writeFile(
      path.join(context.claudeHome, "settings.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    command: "/Users/tedikonda/.vibe-island/bin/vibe-island-bridge --source claude",
                    type: "command"
                  }
                ]
              }
            ],
            Stop: [
              {
                hooks: [
                  {
                    command: "afplay /System/Library/Sounds/Glass.aiff",
                    type: "command"
                  }
                ],
                matcher: ""
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    )

    const skills = createHandoffSkillsService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      bridgeCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-mcp"]
      },
      liveHookCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: []
      }
    })

    await skills.install("both")
    await skills.install("both")

    const codexHooks = await fs.readFile(path.join(context.codexHome, "hooks.json"), "utf8")
    const claudeSettings = await fs.readFile(
      path.join(context.claudeHome, "settings.json"),
      "utf8"
    )

    expect(codexHooks).toContain("vibe-island-bridge --source codex")
    expect(codexHooks).toContain("custom-codex-stop")
    expect(codexHooks.match(/--control-center-hook/g)?.length).toBe(
      CONTROL_CENTER_CODEX_EVENTS.length
    )

    expect(claudeSettings).toContain("vibe-island-bridge --source claude")
    expect(claudeSettings).toContain("afplay /System/Library/Sounds/Glass.aiff")
    expect(claudeSettings.match(/--control-center-hook/g)?.length).toBe(
      CONTROL_CENTER_CLAUDE_EVENTS.length
    )
  })

  it("applies configured MCP tool timeout settings during install and export", async () => {
    context = await createSkillsTestContext()
    await fs.writeFile(
      path.join(context.dataDir, "settings.json"),
      JSON.stringify(
        {
          providers: {
            codex: { binaryPath: "", homePath: "" },
            claude: { binaryPath: "", homePath: "" }
          },
          skills: {
            codex: { toolTimeoutSec: 900 },
            claude: { toolTimeoutSec: 300 }
          },
          terminals: {
            enabledTerminalIds: ["terminal"],
            defaultTerminalId: "terminal"
          },
          agents: []
        },
        null,
        2
      ),
      "utf8"
    )

    const skills = createHandoffSkillsService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      bridgeCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: ["--agent-bridge-mcp"]
      },
      liveHookCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: []
      }
    })

    await skills.install("both")

    await expect(fs.readFile(path.join(context.codexHome, "config.toml"), "utf8")).resolves
      .toContain("tool_timeout_sec = 900")

    await expect(
      fs.readFile(path.join(context.claudeHome, "settings.json"), "utf8")
    ).resolves.toContain('"MCP_TOOL_TIMEOUT": "300"')

    const exportResult = await skills.exportPackage()
    await expect(fs.readFile(path.join(exportResult.exportPath, "codex", "config-snippet.toml"), "utf8")).resolves
      .toContain("tool_timeout_sec = 900")
    await expect(fs.readFile(path.join(exportResult.exportPath, "claude", "mcp-config.json"), "utf8")).resolves
      .toContain('"MCP_TOOL_TIMEOUT": "300"')
  })
})
