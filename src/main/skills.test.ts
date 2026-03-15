import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

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
      }
    })

    const beforeInstall = await skills.getStatus()
    expect(beforeInstall.providers.codex.skillInstalled).toBe(false)
    expect(beforeInstall.providers.claude.skillInstalled).toBe(false)

    const afterInstall = await skills.install("both")
    expect(afterInstall.providers.codex.skillInstalled).toBe(true)
    expect(afterInstall.providers.codex.mcpInstalled).toBe(true)
    expect(afterInstall.providers.claude.skillInstalled).toBe(true)
    expect(afterInstall.providers.claude.mcpInstalled).toBe(true)

    const codexConfig = await fs.readFile(path.join(context.codexHome, "config.toml"), "utf8")
    const claudeConfig = JSON.parse(
      await fs.readFile(path.join(context.claudeHome, "settings.json"), "utf8")
    ) as Record<string, unknown>

    expect(codexConfig).toContain("# BEGIN HANDOFF SKILLS MANAGED BLOCK")
    expect(codexConfig).toContain('[[skills.config]]')
    expect(codexConfig).toContain('handoff-agent-bridge')
    expect(claudeConfig).toMatchObject({
      mcpServers: {
        "handoff-agent-bridge": {
          command: "/Applications/Handoff.app/Contents/MacOS/Handoff",
          args: ["--agent-bridge-mcp"]
        }
      }
    })

    await skills.install("both")
    const codexConfigAfterReinstall = await fs.readFile(
      path.join(context.codexHome, "config.toml"),
      "utf8"
    )
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
      }
    })

    const exportResult = await skills.exportPackage()

    await expect(fs.readFile(path.join(exportResult.codexPath, "SKILL.md"), "utf8")).resolves
      .toContain("Handoff Agent Bridge")
    await expect(
      fs.readFile(path.join(exportResult.codexPath, "agents", "openai.yaml"), "utf8")
    ).resolves.toContain("handoff-agent-bridge")
    await expect(fs.readFile(path.join(exportResult.claudePath, "SKILL.md"), "utf8")).resolves
      .toContain("allowed-tools")
    await expect(fs.readFile(exportResult.claudePluginPath, "utf8")).resolves.toContain(
      "\"handoff-agent-bridge\""
    )
  })
})
