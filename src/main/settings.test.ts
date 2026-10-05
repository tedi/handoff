import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createHandoffSettingsStore } from "./settings"

describe("createHandoffSettingsStore", () => {
  let baseDir: string | null = null

  afterEach(async () => {
    if (baseDir) {
      await fs.rm(baseDir, { recursive: true, force: true })
      baseDir = null
    }
  })

  it("keeps saved legacy data while updating the remaining settings", async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-settings-"))
    const dataDir = path.join(baseDir, "user-data")
    await fs.mkdir(dataDir, { recursive: true })
    const legacyAgents = [{ id: "agent-1", name: "Release reviewer" }]
    await fs.writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
      agents: legacyAgents,
      skills: { codex: { toolTimeoutSec: 900 } }
    }))
    const settingsStore = createHandoffSettingsStore({
      dataDir,
      codexHome: path.join(baseDir, ".codex"),
      claudeHome: path.join(baseDir, ".claude")
    })

    const snapshot = await settingsStore.update({
      providers: { codex: { binaryPath: "/custom/codex" } }
    }, [])
    expect(snapshot.settings).not.toHaveProperty("agents")
    expect(snapshot.settings).not.toHaveProperty("skills")
    expect(snapshot.settings.providers.codex.binaryPath).toBe("/custom/codex")
    expect(snapshot.settings.threadOrganization.viewMode).toBe("chronological")
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "settings.json"), "utf8"))
    expect(persisted.agents).toEqual(legacyAgents)
    expect(persisted.skills.codex.toolTimeoutSec).toBe(900)
    expect(persisted.providers.codex.binaryPath).toBe("/custom/codex")
  })
})
