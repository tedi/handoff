import { app, BrowserWindow, ipcMain } from "electron"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { IPC_CHANNELS } from "../shared/channels"
import { AGENT_BRIDGE_MODE_ARG, AGENT_BRIDGE_WORKER_MODE_ARG, runAgentBridgeWorkerJob } from "./bridge"
import { runAgentBridgeMcpServer } from "./bridge-server"
import { registerIpcHandlers } from "./ipc"
import { createHandoffService } from "./service"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isBridgeMode = process.argv.includes(AGENT_BRIDGE_MODE_ARG)
const workerModeIndex = process.argv.indexOf(AGENT_BRIDGE_WORKER_MODE_ARG)
const isWorkerMode = workerModeIndex >= 0
const workerRunId = isWorkerMode ? process.argv[workerModeIndex + 1] ?? null : null
const service = isBridgeMode || isWorkerMode
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
          }
    })

let disposeIpcHandlers: (() => void) | null = null
let disposeStateSubscription: (() => void) | null = null

function resolveAppIconPath() {
  const iconPath = path.join(app.getAppPath(), "build", "icon.png")
  return fs.existsSync(iconPath) ? iconPath : null
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

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await window.loadFile(path.join(__dirname, "../renderer/index.html"))
  }

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

  if (!service) {
    throw new Error("Handoff service was not initialized.")
  }

  const iconPath = resolveAppIconPath()

  if (process.platform === "darwin" && iconPath) {
    app.dock?.setIcon(iconPath)
  }

  disposeIpcHandlers = registerIpcHandlers(ipcMain, service)
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
    disposeSelectorStateSubscription()
  }

  await service.startWatching()
  await createMainWindow()

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
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
  await service?.dispose()
})
