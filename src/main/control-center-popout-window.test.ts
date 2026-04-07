import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  buildControlCenterPopoutWindowOptions,
  createControlCenterPopoutWindowManager
} from "./control-center-popout-window"

class FakePopoutWindow {
  private readonly bounds
  private readonly listeners = new Map<string, Array<() => void>>()

  focus = vi.fn()
  show = vi.fn()
  close = vi.fn(() => {
    this.emit("close")
    this.emit("closed")
  })
  setAlwaysOnTop = vi.fn()

  constructor(
    initialBounds: { x: number; y: number; width: number; height: number }
  ) {
    this.bounds = { ...initialBounds }
  }

  getBounds() {
    return { ...this.bounds }
  }

  isDestroyed() {
    return false
  }

  isMinimized() {
    return false
  }

  on(event: "move" | "resize" | "close" | "closed", listener: () => void) {
    const currentListeners = this.listeners.get(event) ?? []
    currentListeners.push(listener)
    this.listeners.set(event, currentListeners)
  }

  emit(event: "move" | "resize" | "close" | "closed") {
    for (const listener of this.listeners.get(event) ?? []) {
      listener()
    }
  }
}

describe("control-center-popout-window", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))
    )
  })

  it("builds a frameless always-on-top overlay window config", () => {
    expect(
      buildControlCenterPopoutWindowOptions({
        bounds: {
          x: 32,
          y: 48,
          width: 340,
          height: 240
        },
        iconPath: null,
        preloadPath: "/tmp/preload.cjs"
      })
    ).toMatchObject({
      x: 32,
      y: 48,
      width: 340,
      height: 240,
      minWidth: 340,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      movable: true,
      maximizable: false,
      fullscreenable: false
    })
  })

  it("reuses the existing pop-out window instead of creating a duplicate", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-popout-"))
    tempDirs.push(dataDir)
    const createBrowserWindow = vi.fn(options => new FakePopoutWindow(options))
    const loadWindowContent = vi.fn().mockResolvedValue(undefined)

    const manager = createControlCenterPopoutWindowManager({
      createBrowserWindow,
      dataDir,
      iconPath: null,
      loadWindowContent,
      preloadPath: "/tmp/preload.cjs",
      screen: {
        getAllDisplays: () => [
          {
            workArea: {
              x: 0,
              y: 0,
              width: 1440,
              height: 900
            }
          }
        ],
        getPrimaryDisplay: () => ({
          workArea: {
            x: 0,
            y: 0,
            width: 1440,
            height: 900
          }
        })
      }
    })

    const firstWindow = await manager.open()
    const secondWindow = await manager.open()

    expect(createBrowserWindow).toHaveBeenCalledTimes(1)
    expect(loadWindowContent).toHaveBeenCalledTimes(1)
    expect(firstWindow).toBe(secondWindow)
    expect(firstWindow.focus).toHaveBeenCalledTimes(2)
  })

  it("restores saved bounds and clamps them back onto a visible display", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-popout-"))
    tempDirs.push(dataDir)
    await fs.writeFile(
      path.join(dataDir, "control-center-popout-window.json"),
      JSON.stringify({
        bounds: {
          x: 5200,
          y: 1900,
          width: 1300,
          height: 300
        }
      }),
      "utf8"
    )

    const createBrowserWindow = vi.fn(options => new FakePopoutWindow(options))

    const manager = createControlCenterPopoutWindowManager({
      createBrowserWindow,
      dataDir,
      iconPath: null,
      loadWindowContent: vi.fn().mockResolvedValue(undefined),
      preloadPath: "/tmp/preload.cjs",
      screen: {
        getAllDisplays: () => [
          {
            workArea: {
              x: 0,
              y: 0,
              width: 1440,
              height: 900
            }
          }
        ],
        getPrimaryDisplay: () => ({
          workArea: {
            x: 0,
            y: 0,
            width: 1440,
            height: 900
          }
        })
      }
    })

    await manager.open()

    expect(createBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        width: 1300,
        height: 300
      })
    )

    const options = createBrowserWindow.mock.calls[0]?.[0]
    expect(options.x).toBeGreaterThanOrEqual(0)
    expect(options.y).toBeGreaterThanOrEqual(0)
    expect(options.x + options.width).toBeLessThanOrEqual(1440)
    expect(options.y + options.height).toBeLessThanOrEqual(900)
  })
})
