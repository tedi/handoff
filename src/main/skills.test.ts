import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  CONTROL_CENTER_HOOK_MODE_ARG,
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

  it("installs only live hooks and keeps provider configuration intact", async () => {
    context = await createSkillsTestContext()
    const codexConfigPath = path.join(context.codexHome, "config.toml")
    const codexConfig = 'model = "gpt-5.4"\n'
    await fs.writeFile(codexConfigPath, codexConfig)
    const claudeConfigPath = path.join(context.claudeHome, "settings.json")
    const claudeConfig = {
      permissions: { allow: ["Read"] },
      mcpServers: { existing: { command: "existing-server" } }
    }
    await fs.writeFile(claudeConfigPath, JSON.stringify(claudeConfig))
    const skills = createHandoffSkillsService({
      dataDir: context.dataDir,
      codexHome: context.codexHome,
      claudeHome: context.claudeHome,
      liveHookCommand: {
        command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
        args: []
      }
    })

    const before = await skills.getStatus()
    expect(before.providers.codex.liveHooksInstalled).toBe(false)
    expect(before.providers.claude.liveHooksInstalled).toBe(false)
    const after = await skills.install("both")
    expect(after.providers.codex.liveHooksInstalled).toBe(true)
    expect(after.providers.claude.liveHooksInstalled).toBe(true)
    expect(await fs.readFile(codexConfigPath, "utf8")).toBe(codexConfig)
    expect(JSON.parse(await fs.readFile(claudeConfigPath, "utf8"))).toMatchObject(claudeConfig)
    await expect(fs.access(path.join(context.codexHome, "skills"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(fs.access(path.join(context.claudeHome, "skills"))).rejects.toMatchObject({ code: "ENOENT" })
    const instructions = await skills.getSetupInstructions("both")
    expect(instructions).toContain("Handoff Control Center")
    expect(instructions).toContain(CONTROL_CENTER_HOOK_MODE_ARG)
    expect(instructions).not.toContain("--agent-bridge")
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

})
