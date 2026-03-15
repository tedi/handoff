import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import path from "node:path"

import chokidar from "chokidar"
import {
  callTool,
  cleanupTrash,
  copyTextToClipboard,
  deleteBundle,
  duplicateManifest,
  estimateManifestBundle,
  exportManifestBundle,
  getGitDiffStats,
  getGitStatuses,
  getManifest,
  listFiles,
  listManifests,
  loadConfig,
  previewFile,
  removeFilesFromManifest,
  renameManifest,
  resolveStatePaths,
  setManifestComment,
  setManifestExportText,
  setManifestFileSelection,
  setManifestSelectedPaths
} from "selector"
import type { SelectorGitDiffMode } from "selector"

import type {
  RootListItem,
  SelectorAppOpenPathResult,
  SelectorAppStateChangeEvent,
  SelectorAppStateChangeReason,
  SelectorAppStateInfo
} from "../shared/contracts"

export interface HandoffSelectorServiceOptions {
  cwd?: string
  stateDir?: string
}

export interface HandoffSelectorService {
  app: {
    getStateInfo(): Promise<SelectorAppStateInfo>
    openPath(path: string): Promise<SelectorAppOpenPathResult>
    refresh(): Promise<SelectorAppStateChangeEvent>
  }
  roots: {
    list(): Promise<RootListItem[]>
  }
  git: {
    diffStats(
      paths: string[]
    ): Promise<Awaited<ReturnType<typeof getGitDiffStats>>>
    status(
      paths: string[]
    ): Promise<Awaited<ReturnType<typeof getGitStatuses>>>
  }
  manifests: {
    list(): Promise<Awaited<ReturnType<typeof listManifests>>>
    get(name: string): Promise<Awaited<ReturnType<typeof getManifest>>>
    addFiles(
      name: string,
      paths: string[]
    ): Promise<Awaited<ReturnType<typeof getManifest>>>
    duplicate(
      name: string,
      nextName: string
    ): Promise<Awaited<ReturnType<typeof duplicateManifest>>>
    deleteBundle(
      name: string
    ): Promise<Awaited<ReturnType<typeof deleteBundle>>>
    rename(
      name: string,
      nextName: string
    ): Promise<Awaited<ReturnType<typeof renameManifest>>>
    setComment(
      name: string,
      path: string,
      comment: string
    ): Promise<Awaited<ReturnType<typeof setManifestComment>>>
    setExportText(
      name: string,
      exportPrefixText: string,
      exportSuffixText: string,
      stripComments?: boolean,
      gitDiffModeOrUseGitDiffs?: SelectorGitDiffMode | boolean
    ): Promise<Awaited<ReturnType<typeof setManifestExportText>>>
    setSelected(
      name: string,
      path: string,
      selected: boolean
    ): Promise<Awaited<ReturnType<typeof setManifestFileSelection>>>
    setSelectedPaths(
      name: string,
      paths: string[]
    ): Promise<Awaited<ReturnType<typeof setManifestSelectedPaths>>>
    removeFiles(
      name: string,
      paths: string[]
    ): Promise<Awaited<ReturnType<typeof removeFilesFromManifest>>>
  }
  files: {
    search(
      rootId: string,
      query: string,
      limit?: number
    ): Promise<Awaited<ReturnType<typeof listFiles>>>
    preview(path: string): Promise<Awaited<ReturnType<typeof previewFile>>>
  }
  exports: {
    estimate(
      name: string
    ): Promise<Awaited<ReturnType<typeof estimateManifestBundle>>>
    regenerateAndCopy(name: string): Promise<
      Awaited<ReturnType<typeof exportManifestBundle>> &
        Awaited<ReturnType<typeof copyTextToClipboard>>
    >
  }
  startWatching(): Promise<void>
  onStateChanged(
    listener: (event: SelectorAppStateChangeEvent) => void
  ): () => void
  dispose(): Promise<void>
}

interface OpenPathStrategy {
  label: string
  command: string
  args: string[]
  waitForExit?: boolean
}

const EDITOR_APP_CANDIDATES = [
  "Cursor",
  "Visual Studio Code",
  "Zed"
] as const

function tokenizeCommand(value: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const character of value.trim()) {
    if (escaping) {
      current += character
      escaping = false
      continue
    }

    if (character === "\\") {
      escaping = true
      continue
    }

    if (quote) {
      if (character === quote) {
        quote = null
      } else {
        current += character
      }

      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current)
        current = ""
      }

      continue
    }

    current += character
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

function parseEditorArgs(rawValue: string | undefined): string[] {
  if (!rawValue?.trim()) {
    return []
  }

  try {
    const parsed = JSON.parse(rawValue)
    if (Array.isArray(parsed) && parsed.every(entry => typeof entry === "string")) {
      return parsed
    }
  } catch {}

  return tokenizeCommand(rawValue)
}

function buildOpenPathStrategies(targetPath: string): OpenPathStrategy[] {
  const strategies: OpenPathStrategy[] = []
  const seen = new Set<string>()
  const preferredEditor = process.env.SELECTOR_APP_EDITOR?.trim()
  const preferredArgs = parseEditorArgs(process.env.SELECTOR_APP_EDITOR_ARGS)

  function addStrategy(strategy: OpenPathStrategy) {
    const key = JSON.stringify([
      strategy.command,
      strategy.args,
      strategy.waitForExit ?? false
    ])

    if (seen.has(key)) {
      return
    }

    seen.add(key)
    strategies.push(strategy)
  }

  function addEditorCommand(rawCommand: string | undefined, extraArgs: string[] = []) {
    if (!rawCommand?.trim()) {
      return
    }

    const tokens = tokenizeCommand(rawCommand)
    if (tokens.length === 0) {
      return
    }

    const [command, ...commandArgs] = tokens
    const args = [...commandArgs, ...extraArgs]

    if (process.platform === "darwin" && tokens.length === 1) {
      addStrategy({
        label: command,
        command: "open",
        args: ["-a", command, targetPath],
        waitForExit: true
      })
    }

    addStrategy({
      label: command,
      command,
      args: [...args, targetPath]
    })
  }

  addEditorCommand(preferredEditor, preferredArgs)

  if (process.platform === "darwin") {
    for (const appName of EDITOR_APP_CANDIDATES) {
      addStrategy({
        label: appName,
        command: "open",
        args: ["-a", appName, targetPath],
        waitForExit: true
      })
    }
  }

  addStrategy({
    label: "cursor",
    command: "cursor",
    args: [targetPath]
  })

  if (process.platform === "darwin") {
    addStrategy({
      label: "default app",
      command: "open",
      args: [targetPath],
      waitForExit: true
    })
  }

  return strategies
}

async function launchOpenPathStrategy(strategy: OpenPathStrategy) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(strategy.command, strategy.args, {
      stdio: "ignore",
      detached: strategy.waitForExit !== true
    })

    child.once("error", error => {
      reject(error)
    })

    if (strategy.waitForExit) {
      child.once("exit", code => {
        if (code === 0) {
          resolve()
          return
        }

        reject(
          new Error(
            `Command "${strategy.command}" exited with code ${code ?? "unknown"}.`
          )
        )
      })
      return
    }

    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}

async function openPathInEditor(
  cwd: string,
  targetPath: string
): Promise<SelectorAppOpenPathResult> {
  const resolvedPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(cwd, targetPath)

  await fs.access(resolvedPath)

  const strategies = buildOpenPathStrategies(resolvedPath)
  let lastError: Error | null = null

  for (const strategy of strategies) {
    try {
      await launchOpenPathStrategy(strategy)

      return {
        path: resolvedPath,
        opened_with: strategy.label
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw new Error(
    lastError
      ? `Unable to open "${resolvedPath}" in an editor. ${lastError.message}`
      : `Unable to open "${resolvedPath}" in an editor.`
  )
}

export function createSelectorService(
  options: HandoffSelectorServiceOptions = {}
): HandoffSelectorService {
  const cwd = options.cwd ?? process.cwd()
  const stateDir = options.stateDir
  const paths = resolveStatePaths(stateDir)
  const events = new EventEmitter()
  let watcher: ReturnType<typeof chokidar.watch> | null = null
  let emitTimer: NodeJS.Timeout | null = null

  function buildStateInfo(): SelectorAppStateInfo {
    return {
      stateDir: paths.state_dir,
      configPath: paths.config_path,
      manifestsDir: paths.manifests_dir,
      exportsDir: paths.exports_dir,
      selectorHome: process.env.SELECTOR_HOME ?? null
    }
  }

  function getReason(changedPath: string | null): SelectorAppStateChangeReason {
    if (!changedPath) {
      return "state-changed"
    }

    if (changedPath === paths.config_path) {
      return "config-changed"
    }

    if (changedPath.startsWith(paths.manifests_dir)) {
      return "manifests-changed"
    }

    if (changedPath.startsWith(paths.exports_dir)) {
      return "exports-changed"
    }

    return "state-changed"
  }

  function emitStateChanged(
    reason: SelectorAppStateChangeReason,
    changedPath: string | null = null
  ) {
    const event = {
      at: new Date().toISOString(),
      reason,
      changedPath
    }

    events.emit("state-changed", event)
    return event
  }

  function scheduleStateChanged(changedPath: string | null) {
    if (emitTimer) {
      clearTimeout(emitTimer)
    }

    emitTimer = setTimeout(() => {
      emitTimer = null
      emitStateChanged(getReason(changedPath), changedPath)
    }, 60)
  }

  return {
    app: {
      async getStateInfo() {
        return buildStateInfo()
      },

      async openPath(targetPath) {
        return openPathInEditor(cwd, targetPath)
      },

      async refresh() {
        await cleanupTrash(stateDir)
        return emitStateChanged("manual-refresh")
      }
    },

    roots: {
      async list() {
        const { config } = await loadConfig(stateDir)

        return config.roots.map(root => ({
          id: root.id,
          path: root.path,
          exists: root.exists
        }))
      }
    },

    git: {
      async diffStats(filePaths) {
        return getGitDiffStats(filePaths)
      },

      async status(filePaths) {
        return getGitStatuses(filePaths)
      }
    },

    manifests: {
      async list() {
        return listManifests(stateDir)
      },

      async get(name) {
        return getManifest(stateDir, name)
      },

      async addFiles(name, selectedPaths) {
        const result = await callTool(
          "manifest_add_files",
          {
            name,
            paths: selectedPaths
          },
          {
            cwd,
            stateDir
          }
        )

        return result as Awaited<ReturnType<typeof getManifest>>
      },

      async duplicate(name, nextName) {
        return duplicateManifest(stateDir, name, nextName)
      },

      async deleteBundle(name) {
        return deleteBundle(stateDir, name)
      },

      async rename(name, nextName) {
        return renameManifest(stateDir, name, nextName)
      },

      async setComment(name, targetPath, comment) {
        return setManifestComment(stateDir, name, targetPath, comment)
      },

      async setExportText(
        name,
        exportPrefixText,
        exportSuffixText,
        stripComments,
        gitDiffModeOrUseGitDiffs
      ) {
        return setManifestExportText(
          stateDir,
          name,
          exportPrefixText,
          exportSuffixText,
          stripComments,
          gitDiffModeOrUseGitDiffs
        )
      },

      async setSelected(name, targetPath, selected) {
        return setManifestFileSelection(stateDir, name, targetPath, selected)
      },

      async setSelectedPaths(name, selectedPaths) {
        return setManifestSelectedPaths(stateDir, name, selectedPaths)
      },

      async removeFiles(name, selectedPaths) {
        return removeFilesFromManifest(stateDir, name, selectedPaths)
      }
    },

    files: {
      async search(rootId, query, limit = 120) {
        const trimmedQuery = query.trim()
        const { config } = await loadConfig(stateDir)
        const root = config.roots.find(entry => entry.id === rootId)

        if (!root) {
          throw new Error(`Unknown root id "${rootId}".`)
        }

        if (!trimmedQuery) {
          return {
            root: {
              id: root.id,
              path: root.path
            },
            files: []
          }
        }

        return listFiles(config, {
          root_id: rootId,
          query: trimmedQuery,
          limit: Math.min(Math.max(limit, 1), 200)
        })
      },

      async preview(targetPath) {
        const { config } = await loadConfig(stateDir)
        return previewFile(config, targetPath)
      }
    },

    exports: {
      async estimate(name) {
        const { config } = await loadConfig(stateDir)
        const manifest = await getManifest(stateDir, name)
        return estimateManifestBundle(config, manifest)
      },

      async regenerateAndCopy(name) {
        const { config, paths: loadedPaths } = await loadConfig(stateDir)
        const manifest = await getManifest(stateDir, name)
        const exportResult = await exportManifestBundle(config, manifest, {
          cwd,
          exports_dir: loadedPaths.exports_dir
        })
        const clipboardResult = await copyTextToClipboard(exportResult.text)

        emitStateChanged("exports-changed", exportResult.output_path)

        return {
          ...exportResult,
          ...clipboardResult
        }
      }
    },

    async startWatching() {
      if (watcher) {
        return
      }

      await cleanupTrash(stateDir)

      watcher = chokidar.watch([paths.config_path, paths.manifests_dir, paths.exports_dir], {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 25
        }
      })

      watcher.on("all", (_eventName: string, changedPath: string) => {
        scheduleStateChanged(changedPath ?? null)
      })
    },

    onStateChanged(listener) {
      events.on("state-changed", listener)

      return () => {
        events.off("state-changed", listener)
      }
    },

    async dispose() {
      if (emitTimer) {
        clearTimeout(emitTimer)
        emitTimer = null
      }

      events.removeAllListeners()

      if (watcher) {
        await watcher.close()
        watcher = null
      }
    }
  }
}
