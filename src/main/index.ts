import { app, BrowserWindow, ipcMain, screen } from "electron"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { IPC_CHANNELS } from "../shared/channels"
import {
  APP_WINDOW_MODE_QUERY_PARAM,
  CONTROL_CENTER_POPOUT_WINDOW_MODE
} from "../shared/window-mode"
import { AGENT_BRIDGE_MODE_ARG, AGENT_BRIDGE_WORKER_MODE_ARG, runAgentBridgeWorkerJob } from "./bridge"
import { runAgentBridgeMcpServer } from "./bridge-server"
import {
  createControlCenterPopoutWindowManager,
  type ControlCenterPopoutWindowManager
} from "./control-center-popout-window"
import { CONTROL_CENTER_HOOK_MODE_ARG, runControlCenterHookBridge } from "./control-center"
import { registerIpcHandlers } from "./ipc"
import { createHandoffService } from "./service"
import type { SessionProvider } from "../shared/contracts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isBridgeMode = process.argv.includes(AGENT_BRIDGE_MODE_ARG)
const workerModeIndex = process.argv.indexOf(AGENT_BRIDGE_WORKER_MODE_ARG)
const isWorkerMode = workerModeIndex >= 0
const workerRunId = isWorkerMode ? process.argv[workerModeIndex + 1] ?? null : null
const hookModeIndex = process.argv.indexOf(CONTROL_CENTER_HOOK_MODE_ARG)
const isHookMode = hookModeIndex >= 0

function getArgValue(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] ?? null : null
}

const hookProvider = getArgValue("--provider")
const hookEventName = getArgValue("--event")

const service = isBridgeMode || isWorkerMode || isHookMode
  ? null
  : createHandoffService({
      appDir: app.getAppPath(),
      dataDir: app.getPath("userData"),
      bridgeCommand: app.isPackaged
        ? {
            command: process.execPath,
            args: [AGENT_BRIDGE_MODE_ARG]
          }
        : {
            command: process.execPath,
            args: [app.getAppPath(), AGENT_BRIDGE_MODE_ARG]
          },
      liveHookCommand: app.isPackaged
        ? {
            command: process.execPath,
            args: []
          }
        : {
            command: process.execPath,
            args: [app.getAppPath()]
          }
    })

let disposeIpcHandlers: (() => void) | null = null
let disposeStateSubscription: (() => void) | null = null
let mainWindow: BrowserWindow | null = null
let controlCenterPopoutWindowManager: ControlCenterPopoutWindowManager | null = null

function resolveAppIconPath() {
  const iconPath = path.join(app.getAppPath(), "build", "icon.png")
  return fs.existsSync(iconPath) ? iconPath : null
}

async function loadRendererWindow(
  window: BrowserWindow,
  windowMode: "main" | typeof CONTROL_CENTER_POPOUT_WINDOW_MODE = "main"
) {
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL)
    if (windowMode !== "main") {
      rendererUrl.searchParams.set(APP_WINDOW_MODE_QUERY_PARAM, windowMode)
    }
    await window.loadURL(rendererUrl.toString())
    return
  }

  const query =
    windowMode === "main"
      ? undefined
      : {
          [APP_WINDOW_MODE_QUERY_PARAM]: windowMode
        }

  await window.loadFile(path.join(__dirname, "../renderer/index.html"), query ? { query } : undefined)
}

async function createMainWindow() {
  const iconPath = resolveAppIconPath()
  const window = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#111110",
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(app.getAppPath(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = window
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  await loadRendererWindow(window)

  return window
}

app.whenReady().then(async () => {
  if (isBridgeMode) {
    await runAgentBridgeMcpServer()
    return
  }

  if (isWorkerMode) {
    app.dock?.hide()

    if (!workerRunId) {
      app.exit(1)
      return
    }

    await runAgentBridgeWorkerJob({
      dataDir: app.getPath("userData"),
      runId: workerRunId
    })
    app.exit(0)
    return
  }

  if (isHookMode) {
    app.dock?.hide()

    if (
      hookProvider !== "codex" &&
      hookProvider !== "claude"
    ) {
      app.exit(1)
      return
    }

    if (!hookEventName) {
      app.exit(1)
      return
    }

    await runControlCenterHookBridge({
      dataDir: app.getPath("userData"),
      provider: hookProvider as SessionProvider,
      eventName: hookEventName
    })
    app.exit(0)
    return
  }

  if (!service) {
    throw new Error("Handoff service was not initialized.")
  }

  const iconPath = resolveAppIconPath()
  const preloadPath = path.join(app.getAppPath(), "preload.cjs")
  controlCenterPopoutWindowManager = createControlCenterPopoutWindowManager({
    createBrowserWindow(options) {
      return new BrowserWindow(options)
    },
    dataDir: app.getPath("userData"),
    iconPath,
    async loadWindowContent(window) {
      await loadRendererWindow(
        window as BrowserWindow,
        CONTROL_CENTER_POPOUT_WINDOW_MODE
      )
    },
    preloadPath,
    screen
  })

  if (process.platform === "darwin" && iconPath) {
    app.dock?.setIcon(iconPath)
  }

  disposeIpcHandlers = registerIpcHandlers(ipcMain, service, {
    async closeControlCenterPopout() {
      await controlCenterPopoutWindowManager?.close()
    },
    async openControlCenterPopout() {
      await controlCenterPopoutWindowManager?.open()
    }
  })
  disposeStateSubscription = service.onStateChanged(payload => {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.stateChanged, payload)
      }
    })
  })
  const disposeSearchStatusSubscription = service.onSearchStatusChanged(payload => {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.searchStatusChanged, payload)
      }
    })
  })
  const disposeControlCenterStateSubscription = service.onControlCenterStateChanged(payload => {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.controlCenterStateChanged, payload)
      }
    })
  })
  const disposeSelectorStateSubscription = service.onSelectorStateChanged(payload => {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.selectorStateChanged, payload)
      }
    })
  })
  const previousDisposeStateSubscription = disposeStateSubscription
  disposeStateSubscription = () => {
    previousDisposeStateSubscription?.()
    disposeSearchStatusSubscription()
    disposeControlCenterStateSubscription()
    disposeSelectorStateSubscription()
  }

  await service.startWatching()
  await createMainWindow()

  app.on("activate", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      await createMainWindow()
    }
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", async () => {
  disposeIpcHandlers?.()
  disposeStateSubscription?.()
  await controlCenterPopoutWindowManager?.dispose()
  await service?.dispose()
})
