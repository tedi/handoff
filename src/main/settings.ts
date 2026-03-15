import { randomUUID } from "node:crypto"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  AgentDefinition,
  AgentDeleteResult,
  AgentUpdatePatch,
  HandoffSettings,
  HandoffSettingsPatch,
  HandoffSettingsSnapshot,
  ProviderLaunchOverrides,
  ProviderSettingsInfo,
  SessionListItem,
  SessionProvider,
  TerminalAppId,
  TerminalOption,
  TerminalPreferences
} from "../shared/contracts"
import {
  getDefaultComposerModelId,
  normalizeComposerTarget
} from "../shared/provider-config"

const TERMINAL_OPTIONS: ReadonlyArray<{
  id: TerminalAppId
  label: string
  appPaths: readonly string[]
}> = [
  {
    id: "terminal",
    label: "Terminal",
    appPaths: [
      "/System/Applications/Utilities/Terminal.app",
      "/Applications/Utilities/Terminal.app"
    ]
  },
  {
    id: "ghostty",
    label: "Ghostty",
    appPaths: ["/Applications/Ghostty.app"]
  },
  {
    id: "warp",
    label: "Warp",
    appPaths: ["/Applications/Warp.app"]
  }
] as const

interface SettingsStoreOptions {
  dataDir: string
  codexHome: string
  claudeHome: string
}

const SUPPORTED_THINKING_LEVELS = new Set(["low", "medium", "high", "max"])

const SUPPORTED_TERMINAL_IDS = new Set<TerminalAppId>(
  TERMINAL_OPTIONS.map(option => option.id)
)

function expandHomePath(value: string) {
  if (value === "~") {
    return os.homedir()
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2))
  }

  return value
}

function getInstalledTerminalOptions() {
  return TERMINAL_OPTIONS.map(option => ({
    id: option.id,
    label: option.label,
    installed: option.appPaths.some(appPath => fs.existsSync(appPath))
  })) satisfies TerminalOption[]
}

function getDefaultTerminalPreferences(): TerminalPreferences {
  const installedOptions = getInstalledTerminalOptions()
  const installedIds = installedOptions
    .filter(option => option.installed)
    .map(option => option.id)

  const enabledTerminalIds =
    installedIds.length > 0
      ? (Array.from(new Set<TerminalAppId>(["terminal", ...installedIds])) satisfies TerminalAppId[])
      : (["terminal"] satisfies TerminalAppId[])

  return {
    enabledTerminalIds,
    defaultTerminalId: enabledTerminalIds.includes("terminal")
      ? "terminal"
      : enabledTerminalIds[0]
  }
}

function getDefaultSettings(params: SettingsStoreOptions): HandoffSettings {
  void params
  return {
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
    terminals: getDefaultTerminalPreferences(),
    agents: []
  }
}

function buildUniqueAgentName(existingAgents: AgentDefinition[], baseName: string) {
  const normalizedExistingNames = new Set(
    existingAgents.map(agent => agent.name.trim().toLowerCase()).filter(Boolean)
  )
  const trimmedBaseName = baseName.trim() || "New agent"

  if (!normalizedExistingNames.has(trimmedBaseName.toLowerCase())) {
    return trimmedBaseName
  }

  let suffix = 2
  while (normalizedExistingNames.has(`${trimmedBaseName} ${suffix}`.toLowerCase())) {
    suffix += 1
  }

  return `${trimmedBaseName} ${suffix}`
}

function normalizeThinkingLevel(value: unknown) {
  if (typeof value === "string" && SUPPORTED_THINKING_LEVELS.has(value)) {
    return value as AgentDefinition["thinkingLevel"]
  }

  return "high"
}

function normalizeAgentDefinition(
  value: unknown,
  existingAgents: AgentDefinition[],
  fallbackName: string
): AgentDefinition | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = value as Partial<AgentDefinition>
  const provider = candidate.provider === "claude" ? "claude" : "codex"
  const normalizedTarget = normalizeComposerTarget({
    provider,
    launchMode: "cli",
    modelId:
      typeof candidate.modelId === "string" && candidate.modelId.trim()
        ? candidate.modelId
        : getDefaultComposerModelId(provider),
    fast: candidate.fast === true
  })
  const requestedId = typeof candidate.id === "string" ? candidate.id.trim() : ""
  const nextId =
    requestedId && !existingAgents.some(agent => agent.id === requestedId)
      ? requestedId
      : randomUUID()
  const requestedName = typeof candidate.name === "string" ? candidate.name.trim() : ""

  return {
    id: nextId,
    name: requestedName || buildUniqueAgentName(existingAgents, fallbackName),
    specialty:
      typeof candidate.specialty === "string" ? candidate.specialty : "",
    provider,
    modelId: normalizedTarget.modelId,
    thinkingLevel: normalizeThinkingLevel(candidate.thinkingLevel),
    fast: normalizedTarget.fast,
    customInstructions:
      typeof candidate.customInstructions === "string" ? candidate.customInstructions : ""
  }
}

function normalizeAgents(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as AgentDefinition[]
  }

  const agents: AgentDefinition[] = []
  for (const candidate of value) {
    const normalizedAgent = normalizeAgentDefinition(
      candidate,
      agents,
      "New agent"
    )
    if (normalizedAgent) {
      agents.push(normalizedAgent)
    }
  }

  return agents
}

function normalizeProviderOverrides(
  value: unknown,
  fallback: ProviderLaunchOverrides
): ProviderLaunchOverrides {
  if (!value || typeof value !== "object") {
    return fallback
  }

  const candidate = value as Partial<ProviderLaunchOverrides>
  return {
    binaryPath:
      typeof candidate.binaryPath === "string" ? candidate.binaryPath : fallback.binaryPath,
    homePath:
      typeof candidate.homePath === "string" ? candidate.homePath : fallback.homePath
  }
}

function normalizeTerminalPreferences(
  value: unknown,
  fallback: TerminalPreferences
): TerminalPreferences {
  const installedDefaults = getDefaultTerminalPreferences()

  if (!value || typeof value !== "object") {
    return {
      enabledTerminalIds: fallback.enabledTerminalIds,
      defaultTerminalId: fallback.defaultTerminalId
    }
  }

  const candidate = value as Partial<TerminalPreferences>
  const enabledTerminalIds = Array.isArray(candidate.enabledTerminalIds)
    ? Array.from(
        new Set(
          candidate.enabledTerminalIds.filter(
            (terminalId): terminalId is TerminalAppId =>
              typeof terminalId === "string" &&
              SUPPORTED_TERMINAL_IDS.has(terminalId as TerminalAppId)
          )
        )
      )
    : fallback.enabledTerminalIds

  const normalizedEnabledTerminalIds =
    enabledTerminalIds.length > 0
      ? enabledTerminalIds
      : installedDefaults.enabledTerminalIds

  const candidateDefault =
    typeof candidate.defaultTerminalId === "string" &&
    SUPPORTED_TERMINAL_IDS.has(candidate.defaultTerminalId as TerminalAppId)
      ? (candidate.defaultTerminalId as TerminalAppId)
      : fallback.defaultTerminalId

  return {
    enabledTerminalIds: normalizedEnabledTerminalIds,
    defaultTerminalId: normalizedEnabledTerminalIds.includes(candidateDefault)
      ? candidateDefault
      : normalizedEnabledTerminalIds[0]
  }
}

function normalizeSettings(
  value: unknown,
  params: SettingsStoreOptions
): HandoffSettings {
  const defaults = getDefaultSettings(params)

  if (!value || typeof value !== "object") {
    return defaults
  }

  const candidate = value as Partial<HandoffSettings>
  return {
    providers: {
      codex: normalizeProviderOverrides(candidate.providers?.codex, defaults.providers.codex),
      claude: normalizeProviderOverrides(candidate.providers?.claude, defaults.providers.claude)
    },
    terminals: normalizeTerminalPreferences(candidate.terminals, defaults.terminals),
    agents: normalizeAgents(candidate.agents)
  }
}

function mergeSettingsPatch(
  current: HandoffSettings,
  patch: HandoffSettingsPatch
): HandoffSettings {
  return {
    providers: {
      codex: {
        ...current.providers.codex,
        ...(patch.providers?.codex ?? {})
      },
      claude: {
        ...current.providers.claude,
        ...(patch.providers?.claude ?? {})
      }
    },
    terminals: {
      ...current.terminals,
      ...(patch.terminals ?? {})
    },
    agents: current.agents
  }
}

function createDefaultAgentDefinition(existingAgents: AgentDefinition[]): AgentDefinition {
  return {
    id: randomUUID(),
    name: buildUniqueAgentName(existingAgents, "New agent"),
    specialty: "",
    provider: "codex",
    modelId: getDefaultComposerModelId("codex"),
    thinkingLevel: "high",
    fast: false,
    customInstructions: ""
  }
}

function buildUpdatedAgentDefinition(
  currentAgent: AgentDefinition,
  patch: AgentUpdatePatch
): AgentDefinition {
  const provider = patch.provider ?? currentAgent.provider
  const normalizedTarget = normalizeComposerTarget({
    provider,
    launchMode: "cli",
    modelId: patch.modelId ?? currentAgent.modelId,
    fast: patch.fast ?? currentAgent.fast
  })
  const nextName = (patch.name ?? currentAgent.name).trim()

  if (!nextName) {
    throw new Error("Agent name is required.")
  }

  return {
    ...currentAgent,
    name: nextName,
    specialty: (patch.specialty ?? currentAgent.specialty ?? "").trim(),
    provider,
    modelId: normalizedTarget.modelId,
    thinkingLevel: normalizeThinkingLevel(patch.thinkingLevel ?? currentAgent.thinkingLevel),
    fast: normalizedTarget.fast,
    customInstructions: patch.customInstructions ?? currentAgent.customInstructions
  }
}

function parseTomlStringValue(content: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = content.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.+?)\\s*$`, "m"))
  if (!match) {
    return null
  }

  const rawValue = match[1].trim()
  if (!rawValue) {
    return null
  }

  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1)
  }

  return rawValue.split("#")[0].trim() || null
}

async function readCodexProviderInfo(params: {
  overrides: ProviderLaunchOverrides
  defaultHome: string
}): Promise<ProviderSettingsInfo> {
  const rawBinaryPath = params.overrides.binaryPath.trim()
  const rawHomePath = params.overrides.homePath.trim()
  const effectiveBinaryPath = expandHomePath(rawBinaryPath || "codex")
  const effectiveHomePath = expandHomePath(rawHomePath || params.defaultHome)
  const configPath = path.join(effectiveHomePath, "config.toml")
  const configExists = fs.existsSync(configPath)

  let model: string | null = null
  let reasoningEffort: string | null = null
  let serviceTier: string | null = null

  if (configExists) {
    try {
      const content = await fsPromises.readFile(configPath, "utf8")
      model = parseTomlStringValue(content, "model")
      reasoningEffort = parseTomlStringValue(content, "model_reasoning_effort")
      serviceTier = parseTomlStringValue(content, "service_tier")
    } catch {
      model = null
      reasoningEffort = null
      serviceTier = null
    }
  }

  return {
    provider: "codex",
    binarySource: rawBinaryPath ? "override" : "default",
    effectiveBinaryPath,
    homeSource: rawHomePath ? "override" : "default",
    effectiveHomePath,
    configPath,
    configExists,
    model,
    reasoningEffort,
    serviceTier,
    effortLevel: null,
    alwaysThinkingEnabled: null,
    observedModel: null
  }
}

async function readObservedClaudeModel(sessions: SessionListItem[]) {
  const latestClaudeSession = sessions.find(
    session => session.provider === "claude" && Boolean(session.sessionPath)
  )

  if (!latestClaudeSession?.sessionPath) {
    return null
  }

  try {
    const content = await fsPromises.readFile(latestClaudeSession.sessionPath, "utf8")
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) {
        continue
      }

      let record: Record<string, unknown>
      try {
        record = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      if (!record.message || typeof record.message !== "object") {
        continue
      }

      const model = (record.message as { model?: unknown }).model
      if (typeof model === "string" && model.trim() && model !== "<synthetic>") {
        return model
      }
    }
  } catch {
    return null
  }

  return null
}

async function readClaudeProviderInfo(params: {
  overrides: ProviderLaunchOverrides
  defaultHome: string
  sessions: SessionListItem[]
}): Promise<ProviderSettingsInfo> {
  const rawBinaryPath = params.overrides.binaryPath.trim()
  const rawHomePath = params.overrides.homePath.trim()
  const effectiveBinaryPath = expandHomePath(rawBinaryPath || "claude")
  const effectiveHomePath = expandHomePath(rawHomePath || params.defaultHome)
  const configPath = path.join(effectiveHomePath, "settings.json")
  const configExists = fs.existsSync(configPath)

  let effortLevel: string | null = null
  let alwaysThinkingEnabled: boolean | null = null

  if (configExists) {
    try {
      const content = await fsPromises.readFile(configPath, "utf8")
      const parsed = JSON.parse(content) as Record<string, unknown>
      effortLevel =
        typeof parsed.effortLevel === "string" ? parsed.effortLevel : null
      alwaysThinkingEnabled =
        typeof parsed.alwaysThinkingEnabled === "boolean"
          ? parsed.alwaysThinkingEnabled
          : null
    } catch {
      effortLevel = null
      alwaysThinkingEnabled = null
    }
  }

  return {
    provider: "claude",
    binarySource: rawBinaryPath ? "override" : "default",
    effectiveBinaryPath,
    homeSource: rawHomePath ? "override" : "default",
    effectiveHomePath,
    configPath,
    configExists,
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    effortLevel,
    alwaysThinkingEnabled,
    observedModel: await readObservedClaudeModel(params.sessions)
  }
}

async function buildSettingsSnapshot(params: {
  settings: HandoffSettings
  sessions: SessionListItem[]
  options: SettingsStoreOptions
}): Promise<HandoffSettingsSnapshot> {
  const [codexInfo, claudeInfo] = await Promise.all([
    readCodexProviderInfo({
      overrides: params.settings.providers.codex,
      defaultHome: params.options.codexHome
    }),
    readClaudeProviderInfo({
      overrides: params.settings.providers.claude,
      defaultHome: params.options.claudeHome,
      sessions: params.sessions
    })
  ])

  return {
    settings: params.settings,
    providerInfo: {
      codex: codexInfo,
      claude: claudeInfo
    },
    terminalOptions: getInstalledTerminalOptions()
  }
}

export function createHandoffSettingsStore(options: SettingsStoreOptions) {
  const settingsPath = path.join(options.dataDir, "settings.json")
  let cachedSettings: HandoffSettings | null = null

  async function loadSettings() {
    if (cachedSettings) {
      return cachedSettings
    }

    try {
      const content = await fsPromises.readFile(settingsPath, "utf8")
      cachedSettings = normalizeSettings(JSON.parse(content), options)
    } catch {
      cachedSettings = getDefaultSettings(options)
    }

    return cachedSettings
  }

  async function persistSettings(settings: HandoffSettings) {
    const normalized = normalizeSettings(settings, options)
    await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true })
    await fsPromises.writeFile(settingsPath, JSON.stringify(normalized, null, 2), "utf8")
    cachedSettings = normalized
    return normalized
  }

  return {
    async getSettings() {
      const settings = await loadSettings()
      return {
        providers: {
          codex: { ...settings.providers.codex },
          claude: { ...settings.providers.claude }
        },
        terminals: {
          enabledTerminalIds: [...settings.terminals.enabledTerminalIds],
          defaultTerminalId: settings.terminals.defaultTerminalId
        },
        agents: settings.agents.map(agent => ({ ...agent }))
      }
    },

    async listAgents() {
      const settings = await loadSettings()
      return settings.agents.map(agent => ({ ...agent }))
    },

    async createAgent() {
      const currentSettings = await loadSettings()
      const nextAgent = createDefaultAgentDefinition(currentSettings.agents)
      const persistedSettings = await persistSettings({
        ...currentSettings,
        agents: [...currentSettings.agents, nextAgent]
      })

      return persistedSettings.agents.find(agent => agent.id === nextAgent.id) ?? nextAgent
    },

    async updateAgent(id: string, patch: AgentUpdatePatch) {
      const currentSettings = await loadSettings()
      const currentAgent = currentSettings.agents.find(agent => agent.id === id)

      if (!currentAgent) {
        throw new Error("Agent not found.")
      }

      const updatedAgent = buildUpdatedAgentDefinition(currentAgent, patch)
      const persistedSettings = await persistSettings({
        ...currentSettings,
        agents: currentSettings.agents.map(agent =>
          agent.id === id ? updatedAgent : agent
        )
      })

      return persistedSettings.agents.find(agent => agent.id === id) ?? updatedAgent
    },

    async deleteAgent(id: string): Promise<AgentDeleteResult> {
      const currentSettings = await loadSettings()

      if (!currentSettings.agents.some(agent => agent.id === id)) {
        throw new Error("Agent not found.")
      }

      await persistSettings({
        ...currentSettings,
        agents: currentSettings.agents.filter(agent => agent.id !== id)
      })

      return {
        deletedId: id
      }
    },

    async duplicateAgent(id: string) {
      const currentSettings = await loadSettings()
      const sourceAgent = currentSettings.agents.find(agent => agent.id === id)

      if (!sourceAgent) {
        throw new Error("Agent not found.")
      }

      const duplicatedAgent: AgentDefinition = {
        ...sourceAgent,
        id: randomUUID(),
        name: buildUniqueAgentName(currentSettings.agents, `${sourceAgent.name} copy`)
      }
      const persistedSettings = await persistSettings({
        ...currentSettings,
        agents: [...currentSettings.agents, duplicatedAgent]
      })

      return (
        persistedSettings.agents.find(agent => agent.id === duplicatedAgent.id) ??
        duplicatedAgent
      )
    },

    async getSnapshot(sessions: SessionListItem[]) {
      const settings = await loadSettings()
      return buildSettingsSnapshot({
        settings,
        sessions,
        options
      })
    },

    async update(patch: HandoffSettingsPatch, sessions: SessionListItem[]) {
      const currentSettings = await loadSettings()
      const mergedSettings = mergeSettingsPatch(currentSettings, patch)
      const persistedSettings = await persistSettings(mergedSettings)
      return buildSettingsSnapshot({
        settings: persistedSettings,
        sessions,
        options
      })
    },

    async resetProvider(provider: SessionProvider, sessions: SessionListItem[]) {
      const currentSettings = await loadSettings()
      const defaultSettings = getDefaultSettings(options)
      const persistedSettings = await persistSettings({
        ...currentSettings,
        providers: {
          ...currentSettings.providers,
          [provider]: defaultSettings.providers[provider]
        }
      })

      return buildSettingsSnapshot({
        settings: persistedSettings,
        sessions,
        options
      })
    }
  }
}
