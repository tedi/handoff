import { contextBridge, ipcRenderer } from "electron"

import { createHandoffBridge } from "./api"

contextBridge.exposeInMainWorld("handoffApp", createHandoffBridge(ipcRenderer))
