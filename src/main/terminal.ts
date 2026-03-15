import { execFile } from "node:child_process"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import type { OpenActionResult, TerminalAppId } from "../shared/contracts"

const execFileAsync = promisify(execFile)

const TERMINAL_APP_PATHS: Record<TerminalAppId, string[]> = {
  terminal: [
    "/System/Applications/Utilities/Terminal.app",
    "/Applications/Utilities/Terminal.app"
  ],
  ghostty: ["/Applications/Ghostty.app"],
  warp: ["/Applications/Warp.app"]
}

function appleScriptEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function shellEscape(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function buildGhosttyShellCommand(command: string) {
  return `/bin/bash -lc ${shellEscape(command)}`
}

function buildProjectShellCommand(projectPath: string) {
  return `cd ${shellEscape(projectPath)} && exec "\${SHELL:-/bin/bash}" -l`
}

function scheduleTempFileCleanup(filePath: string) {
  setTimeout(() => {
    void fsPromises.unlink(filePath).catch(() => undefined)
  }, 60_000)
}

export function isTerminalInstalled(terminalId: TerminalAppId) {
  const appPaths = TERMINAL_APP_PATHS[terminalId]
  return appPaths.some(appPath => fs.existsSync(appPath))
}

async function launchInTerminalApp(command: string) {
  const script = [
    'tell application "Terminal"',
    "activate",
    `do script "${appleScriptEscape(command)}"`,
    "end tell"
  ].join("\n")

  await execFileAsync("osascript", ["-e", script])
}

async function launchInGhostty(command: string) {
  const script = [
    'tell application "Ghostty"',
    "activate",
    "set cfg to new surface configuration",
    `set command of cfg to "${appleScriptEscape(buildGhosttyShellCommand(command))}"`,
    "new window with configuration cfg",
    "end tell"
  ].join("\n")

  await execFileAsync("osascript", ["-e", script])
}

async function launchInWarp(command: string) {
  const scriptDir = path.join(os.tmpdir(), "handoff-warp-launches")
  await fsPromises.mkdir(scriptDir, { recursive: true })
  const scriptPath = path.join(
    scriptDir,
    `launch-${Date.now()}-${Math.random().toString(36).slice(2)}.command`
  )

  await fsPromises.writeFile(
    scriptPath,
    `#!/bin/bash\n${command}\n`,
    { encoding: "utf8", mode: 0o755 }
  )
  scheduleTempFileCleanup(scriptPath)

  await execFileAsync("open", ["-a", "Warp", scriptPath])
}

async function launchCommand(terminalId: TerminalAppId, command: string) {
  if (terminalId === "ghostty") {
    await launchInGhostty(command)
    return
  }

  if (terminalId === "warp") {
    await launchInWarp(command)
    return
  }

  await launchInTerminalApp(command)
}

export async function openShellCommandInTerminal(params: {
  preferredTerminalId: TerminalAppId
  command: string
}): Promise<OpenActionResult> {
  const preferredTerminalId = params.preferredTerminalId

  if (isTerminalInstalled(preferredTerminalId)) {
    try {
      await launchCommand(preferredTerminalId, params.command)
      return { fallbackMessage: null }
    } catch (error) {
      if (preferredTerminalId === "terminal" || !isTerminalInstalled("terminal")) {
        throw error
      }
    }
  }

  await launchCommand("terminal", params.command)
  return {
    fallbackMessage: "Selected terminal unavailable. Opened in Terminal instead."
  }
}

export async function openProjectInTerminal(params: {
  preferredTerminalId: TerminalAppId
  projectPath: string
}) {
  return openShellCommandInTerminal({
    preferredTerminalId: params.preferredTerminalId,
    command: buildProjectShellCommand(params.projectPath)
  })
}

export function buildCodexResumeCommand(params: {
  sessionId: string
  sessionCwd?: string | null
  binaryPath: string
  homePath: string
}) {
  const segments = [
    params.sessionCwd ? `cd ${shellEscape(params.sessionCwd)}` : null,
    `export CODEX_HOME=${shellEscape(params.homePath)}`,
    `exec ${shellEscape(params.binaryPath)} resume ${shellEscape(params.sessionId)}`
  ].filter((segment): segment is string => Boolean(segment))

  return segments.join(" && ")
}

export function buildClaudeResumeCommand(params: {
  sessionId: string
  workingDirectory?: string | null
  binaryPath: string
  settingsPath?: string | null
}) {
  const settingsArg = params.settingsPath
    ? ` --settings ${shellEscape(params.settingsPath)}`
    : ""
  const segments = [
    params.workingDirectory ? `cd ${shellEscape(params.workingDirectory)}` : null,
    `exec ${shellEscape(params.binaryPath)}${settingsArg} -r ${shellEscape(params.sessionId)}`
  ].filter((segment): segment is string => Boolean(segment))

  return segments.join(" && ")
}

export function buildCodexStartCommand(params: {
  projectPath: string
  prompt?: string
  binaryPath: string
  homePath: string
  reasoningEffort: string
  serviceTier?: string | null
}) {
  const configSegments = [
    `-c model_reasoning_effort=${shellEscape(params.reasoningEffort)}`,
    params.serviceTier ? `-c service_tier=${shellEscape(params.serviceTier)}` : null
  ].filter((segment): segment is string => Boolean(segment))

  const promptSegment = params.prompt?.trim() ? shellEscape(params.prompt) : null

  const segments = [
    `cd ${shellEscape(params.projectPath)}`,
    `export CODEX_HOME=${shellEscape(params.homePath)}`,
    `exec ${shellEscape(params.binaryPath)} ${configSegments.join(" ")}${promptSegment ? ` ${promptSegment}` : ""}`
  ]

  return segments.join(" && ")
}

export function buildClaudeStartCommand(params: {
  projectPath: string
  prompt?: string
  binaryPath: string
  settingsPath?: string | null
  effortLevel: string
}) {
  const promptSegment = params.prompt?.trim() ? ` ${shellEscape(params.prompt)}` : ""
  const settingsArg = params.settingsPath
    ? ` --settings ${shellEscape(params.settingsPath)}`
    : ""

  const segments = [
    `cd ${shellEscape(params.projectPath)}`,
    `exec ${shellEscape(params.binaryPath)}${settingsArg} --effort ${shellEscape(params.effortLevel)}${promptSegment}`
  ]

  return segments.join(" && ")
}
