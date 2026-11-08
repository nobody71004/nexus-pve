import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, Menu, app, session } from "electron";
import type { NexusEvent } from "../shared/types";
import { IPC } from "../shared/ipc";
import { registerIpc } from "./ipc";
import { createRuntime } from "./agent/runtime";

app.setName("NexusPVE");
const appRoot = app.getAppPath();
const captureArg = process.argv.find((arg) => arg.startsWith("--capture="));
const capturePath = captureArg ? path.resolve(captureArg.split("=")[1]) : undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

let window: BrowserWindow | null = null;

function broadcast(event: NexusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.event, event);
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1680,
    height: 1040,
    minWidth: 1180,
    minHeight: 740,
    show: false,
    frame: false,
    backgroundColor: "#05070d",
    title: "Nexus PVE",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  window.once("ready-to-show", () => {
    window?.show();
    if (capturePath) {
      setTimeout(async () => {
        try {
          const image = await window!.webContents.capturePage();
          fs.mkdirSync(path.dirname(capturePath), { recursive: true });
          fs.writeFileSync(capturePath, image.toPNG());
          console.log(`[capture] wrote ${capturePath}`);
        } catch (err) {
          console.error("[capture] failed", err);
        } finally {
          app.quit();
        }
      }, 4000);
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    event.preventDefault();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(path.join(appRoot, "dist", "index.html"));
  }

  window.on("closed", () => {
    window = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  const runtime = createRuntime(appRoot, broadcast);
  registerIpc(runtime);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

process.on("unhandledRejection", (reason) => {
  console.error("[nexus] unhandled rejection", reason);
});
