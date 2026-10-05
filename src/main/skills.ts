import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  HandoffSettings,
  HandoffSkillsStatus,
  SessionProvider,
  SkillInstallTarget
} from "../shared/contracts"
import {
  buildLiveHookCommandString,
  CONTROL_CENTER_CLAUDE_EVENTS,
  CONTROL_CENTER_CODEX_EVENTS,
  isHandoffLiveHookCommand
} from "./control-center"
import { createHandoffSettingsStore } from "./settings"

interface BridgeCommandConfig {
  command: string
  args: string[]
}

export interface HandoffSkillsServiceOptions {
  dataDir: string
  codexHome: string
  claudeHome: string
  liveHookCommand: BridgeCommandConfig
}

export interface HandoffSkillsService {
  getStatus(): Promise<HandoffSkillsStatus>
  install(target: SkillInstallTarget): Promise<HandoffSkillsStatus>
  getSetupInstructions(target: SkillInstallTarget): Promise<string>
}

function expandHomePath(value: string) {
  if (value === "~") {
    return os.homedir()
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2))
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function buildCodexLiveHookEntry(command: string) {
  return {
    hooks: [
      {
        command,
        timeout: 10,
        type: "command"
      }
    ]
  }
}

function getClaudeLiveHookTimeout(eventName: (typeof CONTROL_CENTER_CLAUDE_EVENTS)[number]) {
  if (eventName === "PermissionRequest" || eventName === "PreToolUse") {
    return 3600
  }

  return 10
}

function buildClaudeLiveHookEntry(
  command: string,
  eventName: (typeof CONTROL_CENTER_CLAUDE_EVENTS)[number],
  matcher?: string
) {
  return {
    hooks: [
      {
        command,
        timeout: getClaudeLiveHookTimeout(eventName),
        type: "command"
      }
    ],
    ...(matcher !== undefined ? { matcher } : {})
  }
}

function getClaudeHookMatcher(eventName: (typeof CONTROL_CENTER_CLAUDE_EVENTS)[number]) {
  if (
    eventName === "Notification" ||
    eventName === "PermissionRequest" ||
    eventName === "PreToolUse" ||
    eventName === "PostToolUse" ||
    eventName === "Stop" ||
    eventName === "UserPromptSubmit"
  ) {
    return "*"
  }

  return undefined
}

function filterManagedHookCommands(entries: unknown[]) {
  return entries
    .map(entry => {
      if (!isRecord(entry)) {
        return entry
      }

      const entryHooks = Array.isArray(entry.hooks) ? entry.hooks : []
      const nextHooks = entryHooks.filter(hook => {
        return !(
          isRecord(hook) &&
          typeof hook.command === "string" &&
          isHandoffLiveHookCommand(hook.command)
        )
      })

      if (entryHooks.length === nextHooks.length) {
        return entry
      }

      if (nextHooks.length === 0) {
        return null
      }

      return {
        ...entry,
        hooks: nextHooks
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null && isRecord(entry))
}

function mergeCodexHooksConfig(
  currentConfig: Record<string, unknown>,
  liveHookCommand: BridgeCommandConfig
) {
  const currentHooks =
    currentConfig.hooks && typeof currentConfig.hooks === "object"
      ? (currentConfig.hooks as Record<string, unknown>)
      : {}

  const nextHooks: Record<string, unknown> = {
    ...currentHooks
  }

  for (const eventName of CONTROL_CENTER_CODEX_EVENTS) {
    const command = buildLiveHookCommandString({
      bridgeCommand: liveHookCommand,
      provider: "codex",
      eventName
    })
    const existingEntries = Array.isArray(currentHooks[eventName])
      ? (currentHooks[eventName] as unknown[])
      : []

    nextHooks[eventName] = [
      ...filterManagedHookCommands(existingEntries),
      buildCodexLiveHookEntry(command)
    ]
  }

  return {
    ...currentConfig,
    hooks: nextHooks
  }
}

function mergeClaudeHooksConfig(
  currentConfig: Record<string, unknown>,
  liveHookCommand: BridgeCommandConfig
) {
  const currentHooks =
    currentConfig.hooks && typeof currentConfig.hooks === "object"
      ? (currentConfig.hooks as Record<string, unknown>)
      : {}

  const nextHooks: Record<string, unknown> = {
    ...currentHooks
  }

  for (const eventName of CONTROL_CENTER_CLAUDE_EVENTS) {
    const command = buildLiveHookCommandString({
      bridgeCommand: liveHookCommand,
      provider: "claude",
      eventName
    })
    const existingEntries = Array.isArray(currentHooks[eventName])
      ? (currentHooks[eventName] as unknown[])
      : []

    nextHooks[eventName] = [
      ...filterManagedHookCommands(existingEntries),
      buildClaudeLiveHookEntry(command, eventName, getClaudeHookMatcher(eventName))
    ]
  }

  return {
    ...currentConfig,
    hooks: nextHooks
  }
}

function hasCodexLiveHooks(
  parsedConfig: Record<string, unknown>,
  liveHookCommand: BridgeCommandConfig
) {
  const parsedHooks =
    parsedConfig.hooks && typeof parsedConfig.hooks === "object"
      ? (parsedConfig.hooks as Record<string, unknown>)
      : {}

  return CONTROL_CENTER_CODEX_EVENTS.every(eventName => {
    const expectedCommand = buildLiveHookCommandString({
      bridgeCommand: liveHookCommand,
      provider: "codex",
      eventName
    })
    const entries = Array.isArray(parsedHooks[eventName]) ? parsedHooks[eventName] : []

    return entries.some(entry => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
        return false
      }

      return entry.hooks.some(hook => {
        return isRecord(hook) && hook.command === expectedCommand
      })
    })
  })
}

function hasClaudeLiveHooks(
  parsedConfig: Record<string, unknown>,
  liveHookCommand: BridgeCommandConfig
) {
  const parsedHooks =
    parsedConfig.hooks && typeof parsedConfig.hooks === "object"
      ? (parsedConfig.hooks as Record<string, unknown>)
      : {}

  return CONTROL_CENTER_CLAUDE_EVENTS.every(eventName => {
    const expectedCommand = buildLiveHookCommandString({
      bridgeCommand: liveHookCommand,
      provider: "claude",
      eventName
    })
    const entries = Array.isArray(parsedHooks[eventName]) ? parsedHooks[eventName] : []

    return entries.some(entry => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
        return false
      }

      return entry.hooks.some(hook => {
        return isRecord(hook) && hook.command === expectedCommand
      })
    })
  })
}

async function readJsonObject(filePath: string) {
  try {
    const content = await fsPromises.readFile(filePath, "utf8")
    return JSON.parse(content) as Record<string, unknown>
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {}
    }

    throw error
  }
}

function getConfigPath(
  settings: HandoffSettings,
  options: HandoffSkillsServiceOptions,
  provider: SessionProvider
) {
  const home = expandHomePath(
    settings.providers[provider].homePath.trim() ||
      (provider === "codex" ? options.codexHome : options.claudeHome)
  )
  return path.join(home, provider === "codex" ? "hooks.json" : "settings.json")
}

async function getProviderStatus(
  provider: SessionProvider,
  configPath: string,
  liveHookCommand: BridgeCommandConfig
) {
  const configExists = await fsPromises.access(configPath).then(() => true).catch(() => false)
  try {
    const config = await readJsonObject(configPath)
    return {
      provider,
      configPath,
      configExists,
      liveHooksInstalled: provider === "codex"
        ? hasCodexLiveHooks(config, liveHookCommand)
        : hasClaudeLiveHooks(config, liveHookCommand),
      error: null
    }
  } catch (error) {
    return {
      provider,
      configPath,
      configExists,
      liveHooksInstalled: false,
      error: error instanceof Error ? error.message : "Unable to read live hook settings."
    }
  }
}

export function createHandoffSkillsService(
  options: HandoffSkillsServiceOptions
): HandoffSkillsService {
  const settingsStore = createHandoffSettingsStore({
    dataDir: options.dataDir,
    codexHome: options.codexHome,
    claudeHome: options.claudeHome
  })

  async function getStatus(): Promise<HandoffSkillsStatus> {
    const settings = await settingsStore.getSettings()
    const [codex, claude] = await Promise.all(
      (["codex", "claude"] as const).map(provider => getProviderStatus(
        provider,
        getConfigPath(settings, options, provider),
        options.liveHookCommand
      ))
    )
    return { providers: { codex, claude } }
  }

  return {
    getStatus,

    async install(target) {
      const settings = await settingsStore.getSettings()
      for (const provider of ["codex", "claude"] as const) {
        if (target !== "both" && target !== provider) {
          continue
        }

        const configPath = getConfigPath(settings, options, provider)
        const currentConfig = await readJsonObject(configPath)
        const nextConfig = provider === "codex"
          ? mergeCodexHooksConfig(currentConfig, options.liveHookCommand)
          : mergeClaudeHooksConfig(currentConfig, options.liveHookCommand)
        await fsPromises.mkdir(path.dirname(configPath), { recursive: true })
        await fsPromises.writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8")
      }
      return getStatus()
    },

    async getSetupInstructions(target) {
      const settings = await settingsStore.getSettings()
      const sections = ["Install live hooks from Handoff Control Center to show live threads."]
      for (const provider of ["codex", "claude"] as const) {
        if (target !== "both" && target !== provider) {
          continue
        }

        const events = provider === "codex"
          ? CONTROL_CENTER_CODEX_EVENTS
          : CONTROL_CENTER_CLAUDE_EVENTS
        sections.push([
          `${provider === "codex" ? "Codex" : "Claude Code"} live hooks:`,
          `Config path: ${getConfigPath(settings, options, provider)}`,
          ...events.map(eventName => `${eventName}: ${buildLiveHookCommandString({
            bridgeCommand: options.liveHookCommand,
            provider,
            eventName
          })}`)
        ].join("\n"))
      }
      return sections.join("\n\n")
    }
  }
}
