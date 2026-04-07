import fsPromises from "node:fs/promises"
import path from "node:path"

import type { BrowserWindowConstructorOptions, Display, Rectangle } from "electron"

const DEFAULT_WIDTH = 1180
const DEFAULT_HEIGHT = 272
const MIN_WIDTH = 680
const MIN_HEIGHT = 148
const WINDOW_MARGIN = 24
const SAVE_DEBOUNCE_MS = 180

interface PersistedControlCenterPopoutState {
  bounds?: Rectangle | null
}

export interface PopoutWindowLike {
  close(): void
  focus(): void
  getBounds(): Rectangle
  isDestroyed(): boolean
  isMinimized?(): boolean
  on(event: "move" | "resize" | "close" | "closed", listener: () => void): void
  restore?(): void
  setAlwaysOnTop(flag: boolean, level?: string, relativeLevel?: number): void
  show(): void
}

export interface ScreenLike {
  getAllDisplays(): Array<Pick<Display, "workArea">>
  getPrimaryDisplay(): Pick<Display, "workArea">
}

export interface ControlCenterPopoutWindowManager {
  close(): Promise<void>
  dispose(): Promise<void>
  getWindow(): PopoutWindowLike | null
  isOpen(): boolean
  open(): Promise<PopoutWindowLike>
}

function clampDimension(value: number, minimum: number, maximum: number) {
  if (maximum <= 0) {
    return minimum
  }

  return Math.min(Math.max(value, minimum), maximum)
}

function getIntersectionArea(left: Rectangle, right: Rectangle) {
  const xOverlap = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  )
  const yOverlap = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  )

  return xOverlap * yOverlap
}

function getBestDisplayForBounds(
  bounds: Rectangle,
  displays: Array<Pick<Display, "workArea">>
) {
  let bestDisplay: Pick<Display, "workArea"> | null = null
  let bestArea = 0

  for (const display of displays) {
    const intersectionArea = getIntersectionArea(bounds, display.workArea)
    if (intersectionArea > bestArea) {
      bestArea = intersectionArea
      bestDisplay = display
    }
  }

  return bestDisplay
}

export function getDefaultControlCenterPopoutBounds(workArea: Rectangle): Rectangle {
  const width = clampDimension(
    DEFAULT_WIDTH,
    MIN_WIDTH,
    Math.max(MIN_WIDTH, workArea.width - WINDOW_MARGIN * 2)
  )
  const height = clampDimension(
    DEFAULT_HEIGHT,
    MIN_HEIGHT,
    Math.max(MIN_HEIGHT, workArea.height - WINDOW_MARGIN * 2)
  )

  return {
    x: workArea.x + Math.max(WINDOW_MARGIN, workArea.width - width - WINDOW_MARGIN),
    y: workArea.y + WINDOW_MARGIN,
    width,
    height
  }
}

export function normalizeControlCenterPopoutBounds(params: {
  bounds: Rectangle
  displays: Array<Pick<Display, "workArea">>
  primaryWorkArea: Rectangle
}): Rectangle {
  const targetDisplay =
    getBestDisplayForBounds(params.bounds, params.displays) ?? {
      workArea: params.primaryWorkArea
    }
  const workArea = targetDisplay.workArea
  const width = clampDimension(params.bounds.width, MIN_WIDTH, workArea.width)
  const height = clampDimension(params.bounds.height, MIN_HEIGHT, workArea.height)
  const x = Math.min(Math.max(params.bounds.x, workArea.x), workArea.x + workArea.width - width)
  const y = Math.min(Math.max(params.bounds.y, workArea.y), workArea.y + workArea.height - height)

  return {
    x,
    y,
    width,
    height
  }
}

export function buildControlCenterPopoutWindowOptions(params: {
  bounds: Rectangle
  iconPath: string | null
  preloadPath: string
}): BrowserWindowConstructorOptions {
  return {
    ...params.bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    movable: true,
    resizable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#050505",
    hasShadow: true,
    ...(params.iconPath ? { icon: params.iconPath } : {}),
    webPreferences: {
      preload: params.preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  }
}

export function getControlCenterPopoutStatePath(dataDir: string) {
  return path.join(dataDir, "control-center-popout-window.json")
}

async function readPersistedBounds(statePath: string) {
  try {
    const parsed = JSON.parse(
      await fsPromises.readFile(statePath, "utf8")
    ) as PersistedControlCenterPopoutState

    if (
      parsed.bounds &&
      typeof parsed.bounds.x === "number" &&
      typeof parsed.bounds.y === "number" &&
      typeof parsed.bounds.width === "number" &&
      typeof parsed.bounds.height === "number"
    ) {
      return parsed.bounds
    }

    return null
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null
    }

    throw error
  }
}

async function writePersistedBounds(statePath: string, bounds: Rectangle) {
  await fsPromises.mkdir(path.dirname(statePath), { recursive: true })
  await fsPromises.writeFile(
    statePath,
    JSON.stringify(
      {
        bounds
      } satisfies PersistedControlCenterPopoutState,
      null,
      2
    ),
    "utf8"
  )
}

export function createControlCenterPopoutWindowManager(params: {
  createBrowserWindow(options: BrowserWindowConstructorOptions): PopoutWindowLike
  dataDir: string
  iconPath: string | null
  loadWindowContent(window: PopoutWindowLike): Promise<void>
  preloadPath: string
  screen: ScreenLike
}): ControlCenterPopoutWindowManager {
  const statePath = getControlCenterPopoutStatePath(params.dataDir)
  let popoutWindow: PopoutWindowLike | null = null
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  function clearPersistTimer() {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
  }

  async function persistBounds(bounds: Rectangle) {
    await writePersistedBounds(statePath, bounds)
  }

  function schedulePersist(window: PopoutWindowLike) {
    clearPersistTimer()
    persistTimer = setTimeout(() => {
      void persistBounds(window.getBounds()).catch(() => undefined)
    }, SAVE_DEBOUNCE_MS)
  }

  async function resolveBounds() {
    const persistedBounds = await readPersistedBounds(statePath)
    if (!persistedBounds) {
      return getDefaultControlCenterPopoutBounds(
        params.screen.getPrimaryDisplay().workArea
      )
    }

    return normalizeControlCenterPopoutBounds({
      bounds: persistedBounds,
      displays: params.screen.getAllDisplays(),
      primaryWorkArea: params.screen.getPrimaryDisplay().workArea
    })
  }

  return {
    async open() {
      if (popoutWindow && !popoutWindow.isDestroyed()) {
        if (popoutWindow.isMinimized?.()) {
          popoutWindow.restore?.()
        }
        popoutWindow.show()
        popoutWindow.focus()
        popoutWindow.setAlwaysOnTop(true, "floating", 1)
        return popoutWindow
      }

      const nextWindow = params.createBrowserWindow(
        buildControlCenterPopoutWindowOptions({
          bounds: await resolveBounds(),
          iconPath: params.iconPath,
          preloadPath: params.preloadPath
        })
      )
      popoutWindow = nextWindow
      nextWindow.setAlwaysOnTop(true, "floating", 1)

      nextWindow.on("move", () => {
        schedulePersist(nextWindow)
      })
      nextWindow.on("resize", () => {
        schedulePersist(nextWindow)
      })
      nextWindow.on("close", () => {
        clearPersistTimer()
        void persistBounds(nextWindow.getBounds()).catch(() => undefined)
      })
      nextWindow.on("closed", () => {
        if (popoutWindow === nextWindow) {
          popoutWindow = null
        }
        clearPersistTimer()
      })

      await params.loadWindowContent(nextWindow)
      nextWindow.show()
      nextWindow.focus()
      return nextWindow
    },

    async close() {
      if (!popoutWindow || popoutWindow.isDestroyed()) {
        return
      }

      popoutWindow.close()
    },

    getWindow() {
      return popoutWindow && !popoutWindow.isDestroyed() ? popoutWindow : null
    },

    isOpen() {
      return Boolean(popoutWindow && !popoutWindow.isDestroyed())
    },

    async dispose() {
      clearPersistTimer()
    }
  }
}
