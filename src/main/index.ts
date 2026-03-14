import { app, BrowserWindow, ipcMain } from "electron"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { IPC_CHANNELS } from "../shared/channels"
import { registerIpcHandlers } from "./ipc"
import { createHandoffService } from "./service"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const service = createHandoffService({
  appDir: app.getAppPath()
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
  await service.dispose()
})
