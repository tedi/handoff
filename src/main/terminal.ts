import { execFile } from "node:child_process"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import type { OpenActionResult, TerminalAppId } from "../shared/contracts"

const execFileAsync = promisify(execFile)
const GHOSTTY_FIELD_SEPARATOR = String.fromCharCode(31)
const GHOSTTY_RECORD_SEPARATOR = String.fromCharCode(30)
const GENERIC_SHELL_TITLES = new Set(["bash", "fish", "sh", "zsh"])

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

export interface GhosttySurfaceInfo {
  windowId: string
  windowName: string
  tabId: string
  tabName: string
  terminalId: string
  terminalName: string
  workingDirectory: string
}

function scheduleTempFileCleanup(filePath: string) {
  setTimeout(() => {
    void fsPromises.unlink(filePath).catch(() => undefined)
  }, 60_000)
}

async function runAppleScript(lines: string[]) {
  await execFileAsync("osascript", lines.flatMap(line => ["-e", line]))
}

async function runAppleScriptText(lines: string[]) {
  const { stdout } = await execFileAsync("osascript", lines.flatMap(line => ["-e", line]))
  return stdout.replace(/\r?\n$/, "")
}

export function isTerminalInstalled(terminalId: TerminalAppId) {
  const appPaths = TERMINAL_APP_PATHS[terminalId]
  return appPaths.some(appPath => fs.existsSync(appPath))
}

async function launchInTerminalApp(command: string) {
  await runAppleScript([
    'tell application "Terminal"',
    "activate",
    `do script "${appleScriptEscape(command)}"`,
    "end tell"
  ])
}

async function launchInGhostty(command: string) {
  await runAppleScript([
    'tell application "Ghostty"',
    "activate",
    "set cfg to new surface configuration",
    `set command of cfg to "${appleScriptEscape(buildGhosttyShellCommand(command))}"`,
    "new window with configuration cfg",
    "end tell"
  ])
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

function normalizeGhosttyMatchValue(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase()
}

function normalizeGhosttyWorkingDirectory(value: string | null | undefined) {
  const normalizedValue = (value ?? "").trim()
  return normalizedValue ? path.normalize(normalizedValue) : ""
}

function buildGhosttySessionCandidates(sessionId: string) {
  const normalizedSessionId = normalizeGhosttyMatchValue(sessionId)
  if (!normalizedSessionId) {
    return []
  }

  const candidates = new Set<string>([normalizedSessionId])

  for (const length of [23, 18, 13, 8]) {
    if (normalizedSessionId.length >= length) {
      candidates.add(normalizedSessionId.slice(0, length).replace(/-+$/, ""))
    }
  }

  const sessionParts = normalizedSessionId.split("-").filter(Boolean)
  for (let index = 2; index <= sessionParts.length; index += 1) {
    candidates.add(sessionParts.slice(0, index).join("-"))
  }

  return [...candidates]
    .map(candidate => candidate.trim())
    .filter(candidate => candidate.length >= 8)
    .sort((left, right) => right.length - left.length)
}

function scoreGhosttySurface(params: {
  surface: GhosttySurfaceInfo
  projectPath?: string | null
  sessionId: string
  threadName?: string | null
}) {
  const normalizedSurfaceTitles = [
    params.surface.tabName,
    params.surface.terminalName
  ]
    .map(normalizeGhosttyMatchValue)
    .filter(Boolean)
  const normalizedWindowTitle = normalizeGhosttyMatchValue(params.surface.windowName)
  const normalizedWorkingDirectory = normalizeGhosttyWorkingDirectory(
    params.surface.workingDirectory
  )
  const normalizedProjectPath = normalizeGhosttyWorkingDirectory(params.projectPath)
  const normalizedThreadName = normalizeGhosttyMatchValue(params.threadName)

  let score = 0

  for (const candidate of buildGhosttySessionCandidates(params.sessionId)) {
    if (normalizedSurfaceTitles.some(title => title.includes(candidate))) {
      score += 300 + candidate.length
      break
    }
  }

  if (
    normalizedThreadName &&
    normalizedSurfaceTitles.some(title => title.includes(normalizedThreadName))
  ) {
    score += 160
  }

  if (normalizedProjectPath && normalizedWorkingDirectory === normalizedProjectPath) {
    score += 40
  }

  if (
    normalizedSurfaceTitles.some(
      title => title && !GENERIC_SHELL_TITLES.has(title)
    )
  ) {
    score += 10
  }

  if (
    score > 0 &&
    normalizedThreadName &&
    normalizedWindowTitle.includes(normalizedThreadName)
  ) {
    score += 5
  }

  return score
}

export function pickGhosttySurfaceForThread(params: {
  surfaces: GhosttySurfaceInfo[]
  projectPath?: string | null
  sessionId: string
  threadName?: string | null
}) {
  let bestMatch: { score: number; surface: GhosttySurfaceInfo } | null = null

  for (const surface of params.surfaces) {
    const score = scoreGhosttySurface({
      surface,
      projectPath: params.projectPath,
      sessionId: params.sessionId,
      threadName: params.threadName
    })

    if (score < 160) {
      continue
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { score, surface }
    }
  }

  return bestMatch?.surface ?? null
}

async function isGhosttyRunning() {
  const status = await runAppleScriptText(['application "Ghostty" is running'])
  return status.trim().toLowerCase() === "true"
}

async function listGhosttySurfaces() {
  const output = await runAppleScriptText([
    'tell application "Ghostty"',
    'set fieldSep to character id 31',
    'set recordSep to character id 30',
    'set outputLines to {}',
    'repeat with w in windows',
    'set windowIdValue to id of w as text',
    'set windowNameValue to ""',
    'try',
    'set windowNameValue to name of w as text',
    'end try',
    'repeat with tb in tabs of w',
    'set tabIdValue to id of tb as text',
    'set tabNameValue to ""',
    'try',
    'set tabNameValue to name of tb as text',
    'end try',
    'repeat with term in terminals of tb',
    'set terminalIdValue to id of term as text',
    'set terminalNameValue to ""',
    'set workingDirectoryValue to ""',
    'try',
    'set terminalNameValue to name of term as text',
    'end try',
    'try',
    'set workingDirectoryValue to working directory of term as text',
    'end try',
    'copy (windowIdValue & fieldSep & windowNameValue & fieldSep & tabIdValue & fieldSep & tabNameValue & fieldSep & terminalIdValue & fieldSep & terminalNameValue & fieldSep & workingDirectoryValue) to end of outputLines',
    'end repeat',
    'end repeat',
    'end repeat',
    "set AppleScript's text item delimiters to recordSep",
    'set outputText to outputLines as text',
    "set AppleScript's text item delimiters to \"\"",
    'return outputText',
    'end tell'
  ])

  if (!output) {
    return [] as GhosttySurfaceInfo[]
  }

  return output
    .split(GHOSTTY_RECORD_SEPARATOR)
    .map(record => record.split(GHOSTTY_FIELD_SEPARATOR))
    .filter((fields): fields is string[] => fields.length === 7)
    .map(fields => ({
      windowId: fields[0] ?? "",
      windowName: fields[1] ?? "",
      tabId: fields[2] ?? "",
      tabName: fields[3] ?? "",
      terminalId: fields[4] ?? "",
      terminalName: fields[5] ?? "",
      workingDirectory: fields[6] ?? ""
    }))
}

async function focusGhosttySurface(terminalId: string) {
  const result = await runAppleScriptText([
    'tell application "Ghostty"',
    "activate",
    "repeat with w in windows",
    "repeat with tb in tabs of w",
    "repeat with term in terminals of tb",
    `if (id of term as text) is "${appleScriptEscape(terminalId)}" then`,
    "select tab tb",
    "activate window w",
    "focus term",
    'return "focused"',
    "end if",
    "end repeat",
    "end repeat",
    "end repeat",
    'return "missing"',
    "end tell"
  ])

  return result.trim() === "focused"
}

export async function focusExistingGhosttyThread(params: {
  sessionId: string
  threadName?: string | null
  projectPath?: string | null
}) {
  if (!isTerminalInstalled("ghostty")) {
    return false
  }

  try {
    if (!(await isGhosttyRunning())) {
      return false
    }

    const surfaces = await listGhosttySurfaces()
    const matchingSurface = pickGhosttySurfaceForThread({
      surfaces,
      projectPath: params.projectPath,
      sessionId: params.sessionId,
      threadName: params.threadName
    })
    if (!matchingSurface) {
      return false
    }

    return focusGhosttySurface(matchingSurface.terminalId)
  } catch {
    return false
  }
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
  modelId: string
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
    `exec ${shellEscape(params.binaryPath)} -m ${shellEscape(params.modelId)} ${configSegments.join(" ")}${promptSegment ? ` ${promptSegment}` : ""}`
  ]

  return segments.join(" && ")
}

export function buildClaudeStartCommand(params: {
  projectPath: string
  prompt?: string
  binaryPath: string
  settingsPath?: string | null
  modelId: string
  effortLevel: string
}) {
  const promptSegment = params.prompt?.trim() ? ` ${shellEscape(params.prompt)}` : ""
  const settingsArg = params.settingsPath
    ? ` --settings ${shellEscape(params.settingsPath)}`
    : ""

  const segments = [
    `cd ${shellEscape(params.projectPath)}`,
    `exec ${shellEscape(params.binaryPath)}${settingsArg} --model ${shellEscape(params.modelId)} --effort ${shellEscape(params.effortLevel)}${promptSegment}`
  ]

  return segments.join(" && ")
}
