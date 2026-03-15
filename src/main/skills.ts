import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  HandoffSettings,
  HandoffSkillsExportResult,
  HandoffSkillsStatus,
  SessionProvider,
  SkillInstallTarget
} from "../shared/contracts"
import { AGENT_BRIDGE_SERVER_NAME } from "./bridge"
import { createHandoffSettingsStore } from "./settings"

const HANDOFF_SKILL_NAME = AGENT_BRIDGE_SERVER_NAME
const CODEX_MANAGED_BLOCK_START = "# BEGIN HANDOFF SKILLS MANAGED BLOCK"
const CODEX_MANAGED_BLOCK_END = "# END HANDOFF SKILLS MANAGED BLOCK"

interface BridgeCommandConfig {
  command: string
  args: string[]
}

export interface HandoffSkillsServiceOptions {
  dataDir: string
  codexHome: string
  claudeHome: string
  bridgeCommand: BridgeCommandConfig
}

export interface HandoffSkillsService {
  getStatus(): Promise<HandoffSkillsStatus>
  install(target: SkillInstallTarget): Promise<HandoffSkillsStatus>
  exportPackage(): Promise<HandoffSkillsExportResult>
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

function ensureTrailingNewline(value: string) {
  return value.endsWith("\n") ? value : `${value}\n`
}

function ensureParentDirectory(filePath: string) {
  return fsPromises.mkdir(path.dirname(filePath), { recursive: true })
}

function fileExists(filePath: string) {
  return fsPromises
    .access(filePath)
    .then(() => true)
    .catch(() => false)
}

function escapeTomlString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
}

function buildCodexSkillMarkdown() {
  return ensureTrailingNewline(`---
name: ${HANDOFF_SKILL_NAME}
description: Delegate work to a saved Handoff agent through the local ${AGENT_BRIDGE_SERVER_NAME} MCP bridge. Use when the user asks for specialist input, explicitly names a saved Handoff agent, or when a task should be handed off to a reviewer, planner, or other saved expert. Prefer an exact saved agent name match when one is mentioned; otherwise inspect saved agents and choose the best specialty match, asking the user when the match is unclear.
---

# Handoff Agent Bridge

Use the local Handoff bridge to consult one saved Handoff agent and then continue the current task.

## Workflow

1. If the user explicitly names a saved Handoff agent, use that exact agent first.
2. Otherwise call \`list_agents\` and select the best match by \`specialty\`.
3. If \`specialty\` is missing or ambiguous, use agent name and custom instructions as weaker hints.
4. If no confident match exists, ask the user which saved Handoff agent to use instead of guessing.
5. Use the current working directory or repo root as \`projectPath\`.
6. Call \`ask_agent\` with the chosen agent, a concise question, and optional context.
7. Use the final answer in your response. If the bridge call fails, say so briefly and continue with the best direct answer you can provide.

## Limits

- Use one Handoff agent call by default.
- Make additional calls only if the user explicitly asks for multiple specialist opinions.
`)
}

function buildCodexOpenAiYaml() {
  return ensureTrailingNewline(`interface:
  display_name: "Handoff Agent Bridge"
  short_description: "Delegate to saved Handoff agents"
  default_prompt: "Use $${HANDOFF_SKILL_NAME} to ask the most relevant saved Handoff agent for a specialist answer through the local bridge."

dependencies:
  tools:
    - type: "mcp"
      value: "${AGENT_BRIDGE_SERVER_NAME}"
      description: "Local Handoff MCP bridge for saved agents"

policy:
  allow_implicit_invocation: true
`)
}

function buildClaudeSkillMarkdown() {
  return ensureTrailingNewline(`---
name: ${HANDOFF_SKILL_NAME}
description: Delegate work to a saved Handoff agent through the local ${AGENT_BRIDGE_SERVER_NAME} MCP bridge. Use when the user asks for specialist input, explicitly names a saved Handoff agent, or when a task should be handed off to a reviewer, planner, or other saved expert. Prefer an exact saved agent name match when one is mentioned; otherwise inspect saved agents and choose the best specialty match, asking the user when the match is unclear.
allowed-tools: mcp__${AGENT_BRIDGE_SERVER_NAME}__list_agents, mcp__${AGENT_BRIDGE_SERVER_NAME}__get_agent, mcp__${AGENT_BRIDGE_SERVER_NAME}__ask_agent
---

# Handoff Agent Bridge

Use the local Handoff bridge to consult one saved Handoff agent and then continue the current task.

## Workflow

1. If the user explicitly names a saved Handoff agent, use that exact agent first.
2. Otherwise call \`list_agents\` and select the best match by \`specialty\`.
3. If \`specialty\` is missing or ambiguous, use agent name and custom instructions as weaker hints.
4. If no confident match exists, ask the user which saved Handoff agent to use instead of guessing.
5. Use the current working directory or repo root as \`projectPath\`.
6. Call \`ask_agent\` with the chosen agent, a concise question, and optional context.
7. Use the final answer in your response. If the bridge call fails, say so briefly and continue with the best direct answer you can provide.

## Limits

- Use one Handoff agent call by default.
- Make additional calls only if the user explicitly asks for multiple specialist opinions.
`)
}

function buildClaudeMarketplaceJson() {
  return ensureTrailingNewline(
    JSON.stringify(
      {
        name: HANDOFF_SKILL_NAME,
        owner: {
          name: "Handoff",
          email: "handoff@local"
        },
        metadata: {
          description: "Handoff bridge skill for saved local agents",
          version: "1.0.0"
        },
        plugins: [
          {
            name: HANDOFF_SKILL_NAME,
            description: "Delegate to saved Handoff agents through the local bridge",
            source: "./",
            strict: false,
            skills: [`./claude/${HANDOFF_SKILL_NAME}`]
          }
        ]
      },
      null,
      2
    )
  )
}

function buildClaudeMcpConfig(command: string, args: string[]) {
  return {
    mcpServers: {
      [AGENT_BRIDGE_SERVER_NAME]: {
        command,
        args
      }
    }
  }
}

function buildCodexManagedBlock(command: string, args: string[], skillPath: string) {
  return ensureTrailingNewline(
    [
      CODEX_MANAGED_BLOCK_START,
      `[mcp_servers.${escapeTomlString(AGENT_BRIDGE_SERVER_NAME)}]`,
      `command = ${escapeTomlString(command)}`,
      `args = [${args.map(escapeTomlString).join(", ")}]`,
      "enabled = true",
      "",
      "[[skills.config]]",
      `path = ${escapeTomlString(skillPath)}`,
      "enabled = true",
      CODEX_MANAGED_BLOCK_END
    ].join("\n")
  )
}

function upsertManagedBlock(content: string, block: string) {
  const pattern = new RegExp(
    `${CODEX_MANAGED_BLOCK_START}[\\s\\S]*?${CODEX_MANAGED_BLOCK_END}\\n?`,
    "m"
  )

  if (pattern.test(content)) {
    return ensureTrailingNewline(content.replace(pattern, block))
  }

  if (!content.trim()) {
    return block
  }

  return ensureTrailingNewline(`${content.trimEnd()}\n\n${block}`)
}

async function writeSkillDirectory(skillDir: string, files: Record<string, string>) {
  await fsPromises.mkdir(skillDir, { recursive: true })

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(skillDir, relativePath)
    await ensureParentDirectory(filePath)
    await fsPromises.writeFile(filePath, content, "utf8")
  }
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

function mergeClaudeMcpConfig(
  currentConfig: Record<string, unknown>,
  command: string,
  args: string[]
) {
  const currentMcpServers =
    currentConfig.mcpServers && typeof currentConfig.mcpServers === "object"
      ? (currentConfig.mcpServers as Record<string, unknown>)
      : {}

  return {
    ...currentConfig,
    mcpServers: {
      ...currentMcpServers,
      [AGENT_BRIDGE_SERVER_NAME]: {
        command,
        args
      }
    }
  }
}

function normalizeSettingsPaths(settings: HandoffSettings, options: HandoffSkillsServiceOptions) {
  const codexHomePath = expandHomePath(
    settings.providers.codex.homePath.trim() || options.codexHome
  )
  const claudeHomePath = expandHomePath(
    settings.providers.claude.homePath.trim() || options.claudeHome
  )

  return {
    codexHomePath,
    claudeHomePath,
    codexConfigPath: path.join(codexHomePath, "config.toml"),
    claudeConfigPath: path.join(claudeHomePath, "settings.json"),
    codexSkillPath: path.join(
      codexHomePath,
      "skills",
      HANDOFF_SKILL_NAME,
      "SKILL.md"
    ),
    claudeSkillPath: path.join(
      claudeHomePath,
      "skills",
      HANDOFF_SKILL_NAME,
      "SKILL.md"
    ),
    managedRoot: path.join(options.dataDir, "skills"),
    exportRoot: path.join(options.dataDir, "skill-exports")
  }
}

async function getCodexProviderStatus(params: {
  configPath: string
  skillPath: string
}) {
  const configExists = await fileExists(params.configPath)
  const skillInstalled = await fileExists(params.skillPath)

  if (!configExists) {
    return {
      provider: "codex" as const,
      configPath: params.configPath,
      configExists: false,
      skillPath: params.skillPath,
      skillInstalled,
      mcpInstalled: false,
      managedConfigBlock: false,
      error: null
    }
  }

  const content = await fsPromises.readFile(params.configPath, "utf8")
  const managedConfigBlock =
    content.includes(CODEX_MANAGED_BLOCK_START) && content.includes(CODEX_MANAGED_BLOCK_END)
  const managedBlockMatch = content.match(
    new RegExp(`${CODEX_MANAGED_BLOCK_START}[\\s\\S]*?${CODEX_MANAGED_BLOCK_END}`, "m")
  )
  const managedBlockContent = managedBlockMatch?.[0] ?? ""

  return {
    provider: "codex" as const,
    configPath: params.configPath,
    configExists: true,
    skillPath: params.skillPath,
    skillInstalled,
    mcpInstalled: managedBlockContent.includes(AGENT_BRIDGE_SERVER_NAME),
    managedConfigBlock,
    error: null
  }
}

async function getClaudeProviderStatus(params: {
  configPath: string
  skillPath: string
  command: string
  args: string[]
}) {
  const configExists = await fileExists(params.configPath)
  const skillInstalled = await fileExists(params.skillPath)

  if (!configExists) {
    return {
      provider: "claude" as const,
      configPath: params.configPath,
      configExists: false,
      skillPath: params.skillPath,
      skillInstalled,
      mcpInstalled: false,
      managedConfigBlock: false,
      error: null
    }
  }

  try {
    const parsedConfig = await readJsonObject(params.configPath)
    const server =
      parsedConfig.mcpServers &&
      typeof parsedConfig.mcpServers === "object" &&
      (parsedConfig.mcpServers as Record<string, unknown>)[AGENT_BRIDGE_SERVER_NAME] &&
      typeof (parsedConfig.mcpServers as Record<string, unknown>)[AGENT_BRIDGE_SERVER_NAME] ===
        "object"
        ? ((parsedConfig.mcpServers as Record<string, unknown>)[
            AGENT_BRIDGE_SERVER_NAME
          ] as Record<string, unknown>)
        : null
    const commandMatches = server?.command === params.command
    const argsMatch = JSON.stringify(server?.args ?? null) === JSON.stringify(params.args)

    return {
      provider: "claude" as const,
      configPath: params.configPath,
      configExists: true,
      skillPath: params.skillPath,
      skillInstalled,
      mcpInstalled: Boolean(server) && commandMatches && argsMatch,
      managedConfigBlock: false,
      error: null
    }
  } catch (error) {
    return {
      provider: "claude" as const,
      configPath: params.configPath,
      configExists: true,
      skillPath: params.skillPath,
      skillInstalled,
      mcpInstalled: false,
      managedConfigBlock: false,
      error: error instanceof Error ? error.message : "Unable to read Claude settings."
    }
  }
}

function buildArtifacts() {
  return {
    codex: {
      "SKILL.md": buildCodexSkillMarkdown(),
      "agents/openai.yaml": buildCodexOpenAiYaml()
    },
    claude: {
      "SKILL.md": buildClaudeSkillMarkdown()
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

  async function getSettings() {
    return settingsStore.getSettings()
  }

  async function getStatus(): Promise<HandoffSkillsStatus> {
    const settings = await getSettings()
    const paths = normalizeSettingsPaths(settings, options)
    const [codexStatus, claudeStatus] = await Promise.all([
      getCodexProviderStatus({
        configPath: paths.codexConfigPath,
        skillPath: paths.codexSkillPath
      }),
      getClaudeProviderStatus({
        configPath: paths.claudeConfigPath,
        skillPath: paths.claudeSkillPath,
        command: options.bridgeCommand.command,
        args: options.bridgeCommand.args
      })
    ])

    return {
      skillName: HANDOFF_SKILL_NAME,
      managedRoot: paths.managedRoot,
      exportRoot: paths.exportRoot,
      providers: {
        codex: codexStatus,
        claude: claudeStatus
      }
    }
  }

  async function installCodex(settings: HandoffSettings) {
    const paths = normalizeSettingsPaths(settings, options)
    const skillDir = path.dirname(paths.codexSkillPath)
    const artifacts = buildArtifacts()

    await writeSkillDirectory(skillDir, artifacts.codex)
    await fsPromises.mkdir(path.dirname(paths.codexConfigPath), { recursive: true })

    const currentConfig = (await fileExists(paths.codexConfigPath))
      ? await fsPromises.readFile(paths.codexConfigPath, "utf8")
      : ""
    const nextConfig = upsertManagedBlock(
      currentConfig,
      buildCodexManagedBlock(
        options.bridgeCommand.command,
        options.bridgeCommand.args,
        paths.codexSkillPath
      )
    )

    await fsPromises.writeFile(paths.codexConfigPath, nextConfig, "utf8")
  }

  async function installClaude(settings: HandoffSettings) {
    const paths = normalizeSettingsPaths(settings, options)
    const skillDir = path.dirname(paths.claudeSkillPath)
    const artifacts = buildArtifacts()

    await writeSkillDirectory(skillDir, artifacts.claude)
    await fsPromises.mkdir(path.dirname(paths.claudeConfigPath), { recursive: true })

    const currentConfig = await readJsonObject(paths.claudeConfigPath)
    const nextConfig = mergeClaudeMcpConfig(
      currentConfig,
      options.bridgeCommand.command,
      options.bridgeCommand.args
    )
    await fsPromises.writeFile(paths.claudeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8")
  }

  async function exportPackage(): Promise<HandoffSkillsExportResult> {
    const exportPath = path.join(
      options.dataDir,
      "skill-exports",
      new Date().toISOString().replaceAll(":", "-")
    )
    const codexPath = path.join(exportPath, "codex", HANDOFF_SKILL_NAME)
    const claudePath = path.join(exportPath, "claude", HANDOFF_SKILL_NAME)
    const claudePluginPath = path.join(exportPath, ".claude-plugin", "marketplace.json")
    const artifacts = buildArtifacts()

    await writeSkillDirectory(codexPath, artifacts.codex)
    await writeSkillDirectory(claudePath, artifacts.claude)
    await ensureParentDirectory(claudePluginPath)
    await fsPromises.writeFile(claudePluginPath, buildClaudeMarketplaceJson(), "utf8")

    await fsPromises.writeFile(
      path.join(exportPath, "codex", "config-snippet.toml"),
      buildCodexManagedBlock(
        options.bridgeCommand.command,
        options.bridgeCommand.args,
        path.join(codexPath, "SKILL.md")
      ),
      "utf8"
    )
    await fsPromises.writeFile(
      path.join(exportPath, "claude", "mcp-config.json"),
      ensureTrailingNewline(
        JSON.stringify(
          buildClaudeMcpConfig(options.bridgeCommand.command, options.bridgeCommand.args),
          null,
          2
        )
      ),
      "utf8"
    )

    return {
      exportPath,
      codexPath,
      claudePath,
      claudePluginPath
    }
  }

  async function buildSetupInstructions(target: SkillInstallTarget) {
    const status = await getStatus()
    const sections: string[] = [
      `Handoff generic skill: ${status.skillName}`,
      "Automatic local install is available from the Handoff Agents screen."
    ]

    if (target === "codex" || target === "both") {
      sections.push(
        [
          "Codex manual setup:",
          `- Config path: ${status.providers.codex.configPath}`,
          `- Skill path: ${status.providers.codex.skillPath}`,
          "- Add or update the Handoff managed block in config.toml so it declares the handoff-agent-bridge MCP server and the skills.config path."
        ].join("\n")
      )
    }

    if (target === "claude" || target === "both") {
      sections.push(
        [
          "Claude Code manual setup:",
          `- Settings path: ${status.providers.claude.configPath}`,
          `- Skill path: ${status.providers.claude.skillPath}`,
          `- Copy the skill folder into ~/.claude/skills/${HANDOFF_SKILL_NAME}`,
          "- Merge the handoff-agent-bridge mcpServers entry into settings.json."
        ].join("\n")
      )
    }

    sections.push(`Portable export root: ${status.exportRoot}`)
    return sections.join("\n\n")
  }

  return {
    getStatus,

    async install(target) {
      const settings = await getSettings()

      if (target === "codex" || target === "both") {
        await installCodex(settings)
      }

      if (target === "claude" || target === "both") {
        await installClaude(settings)
      }

      return getStatus()
    },

    exportPackage,

    getSetupInstructions: buildSetupInstructions
  }
}
