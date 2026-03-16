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

  it("persists agent specialty and timeout across create and update", async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-settings-"))
    const dataDir = path.join(baseDir, "user-data")
    const settingsStore = createHandoffSettingsStore({
      dataDir,
      codexHome: path.join(baseDir, ".codex"),
      claudeHome: path.join(baseDir, ".claude")
    })

    const createdAgent = await settingsStore.createAgent()
    const updatedAgent = await settingsStore.updateAgent(createdAgent.id, {
      name: "Release reviewer",
      specialty: "Use for release planning and ship reviews.",
      timeoutSec: 900
    })
    const agents = await settingsStore.listAgents()
    const persistedSettings = JSON.parse(
      await fs.readFile(path.join(dataDir, "settings.json"), "utf8")
    ) as {
      agents: Array<{ id: string; specialty?: string; timeoutSec?: number | null }>
    }

    expect(updatedAgent.specialty).toBe("Use for release planning and ship reviews.")
    expect(updatedAgent.timeoutSec).toBe(900)
    expect(agents[0]?.specialty).toBe("Use for release planning and ship reviews.")
    expect(agents[0]?.timeoutSec).toBe(900)
    expect(
      persistedSettings.agents.find(agent => agent.id === createdAgent.id)?.specialty
    ).toBe("Use for release planning and ship reviews.")
    expect(
      persistedSettings.agents.find(agent => agent.id === createdAgent.id)?.timeoutSec
    ).toBe(900)
  })

  it("persists provider MCP timeout settings", async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-settings-"))
    const dataDir = path.join(baseDir, "user-data")
    const settingsStore = createHandoffSettingsStore({
      dataDir,
      codexHome: path.join(baseDir, ".codex"),
      claudeHome: path.join(baseDir, ".claude")
    })

    const updatedSnapshot = await settingsStore.update(
      {
        skills: {
          codex: { toolTimeoutSec: 900 },
          claude: { toolTimeoutSec: 300 }
        }
      },
      []
    )
    const persistedSettings = JSON.parse(
      await fs.readFile(path.join(dataDir, "settings.json"), "utf8")
    ) as {
      skills?: {
        codex?: { toolTimeoutSec?: number | null }
        claude?: { toolTimeoutSec?: number | null }
      }
    }

    expect(updatedSnapshot.settings.skills?.codex.toolTimeoutSec).toBe(900)
    expect(updatedSnapshot.settings.skills?.claude.toolTimeoutSec).toBe(300)
    expect(persistedSettings.skills?.codex?.toolTimeoutSec).toBe(900)
    expect(persistedSettings.skills?.claude?.toolTimeoutSec).toBe(300)
  })
})
