export type AppWindowMode = "main" | "control-center-popout"

export const APP_WINDOW_MODE_QUERY_PARAM = "window"
export const CONTROL_CENTER_POPOUT_WINDOW_MODE: AppWindowMode =
  "control-center-popout"

export function getAppWindowModeFromSearch(search: string): AppWindowMode {
  const params = new URLSearchParams(search)
  return params.get(APP_WINDOW_MODE_QUERY_PARAM) === CONTROL_CENTER_POPOUT_WINDOW_MODE
    ? CONTROL_CENTER_POPOUT_WINDOW_MODE
    : "main"
}

