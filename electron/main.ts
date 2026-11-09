import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, Menu, app, dialog, session } from "electron";
import type { NexusEvent } from "../shared/types";
import { IPC } from "../shared/ipc";
import { registerIpc } from "./ipc";
import { createRuntime, mcpServerPath, type Runtime } from "./agent/runtime";
import { TeamService } from "./team/store";
import { TeamSyncService } from "./team/sync";

app.setName("NexusPVE");
const smokeUserData = process.env.NEXUS_PVE_SMOKE_USER_DATA;
if (smokeUserData) {
  const resolved = path.resolve(smokeUserData);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  app.setPath("userData", resolved);
}
const appRoot = app.getAppPath();
const captureArg = process.argv.find((arg) => arg.startsWith("--capture="));
const capturePath = captureArg ? path.resolve(captureArg.split("=")[1]) : undefined;
const smokeReportPath = process.env.NEXUS_PVE_SMOKE_REPORT ? path.resolve(process.env.NEXUS_PVE_SMOKE_REPORT) : undefined;
const smokePassword = process.env.NEXUS_PVE_SMOKE_PASSWORD || "nexus-smoke-owner-123";

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
let team: TeamService | null = null;
let teamSync: TeamSyncService | null = null;
let appRuntime: Runtime | null = null;
let smokeProfile: SmokeProfile | null = null;

interface SmokeProfile {
  seeded: boolean;
  username: string;
  displayName: string;
  role: string;
}

function broadcast(event: NexusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.event, event);
  }
}

function writeSmokeReport(report: Record<string, unknown>): void {
  if (!smokeReportPath) return;
  try {
    fs.mkdirSync(path.dirname(smokeReportPath), { recursive: true });
    fs.writeFileSync(smokeReportPath, JSON.stringify(report, null, 2));
  } catch (error) {
    console.error("[smoke] could not write report", error);
  }
}

function mcpSmokeInfo(): Record<string, unknown> {
  const serverPath = mcpServerPath(app.getAppPath(), app.isPackaged);
  return {
    serverPath,
    serverPresent: fs.existsSync(serverPath),
    toolCount: appRuntime?.registry.list().length ?? 0,
  };
}

async function seedSmokeProfile(service: TeamService): Promise<SmokeProfile> {
  if (!service.hasUsers()) {
    const user = await service.bootstrap({
      username: "smoke-owner",
      displayName: "Smoke Owner",
      password: smokePassword,
    });
    return { seeded: true, username: user.username, displayName: user.displayName, role: user.role };
  }
  const state = service.status();
  if (state.user) {
    return { seeded: false, username: state.user.username, displayName: state.user.displayName, role: state.user.role };
  }
  const user = await service.login({ username: "smoke-owner", password: smokePassword });
  return { seeded: false, username: user.username, displayName: user.displayName, role: user.role };
}

async function attachSmokeReport(win: BrowserWindow): Promise<void> {
  win.webContents.once("did-finish-load", async () => {
    try {
      const renderer = await win.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 15000;
        let text = "";
        while (Date.now() < deadline) {
          text = document.body ? document.body.innerText : "";
          if (window.nexus && text.includes("Fleet overview")) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        let auth = null;
        try {
          auth = window.nexus ? await window.nexus.auth.status() : null;
        } catch (error) {
          auth = { error: String(error) };
        }
        return {
          title: document.title,
          root: Boolean(document.querySelector("#root")),
          bridge: Boolean(window.nexus),
          auth,
          nav: Array.from(document.querySelectorAll(".rail-nav button")).map(
            (node) => node.getAttribute("aria-label") || node.textContent?.trim() || "",
          ),
          text: text.slice(0, 4000),
        };
      })()`);
      writeSmokeReport({
        ok: true,
        version: app.getVersion(),
        profile: smokeProfile,
        renderer,
        mcp: mcpSmokeInfo(),
      });
    } catch (error) {
      writeSmokeReport({
        ok: false,
        version: app.getVersion(),
        profile: smokeProfile,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        mcp: mcpSmokeInfo(),
      });
    } finally {
      setTimeout(() => app.quit(), 100);
    }
  });
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

  if (smokeReportPath) void attachSmokeReport(window);

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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  try {
    const runtime = createRuntime(appRoot, broadcast);
    appRuntime = runtime;
    team = await TeamService.open(appRoot);
    teamSync = new TeamSyncService(team, (status) => broadcast({ type: "team-sync", teamSync: status }));
    if (smokeReportPath) smokeProfile = await seedSmokeProfile(team);
    registerIpc(runtime, team, teamSync);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (smokeReportPath) {
      writeSmokeReport({
        ok: false,
        version: app.getVersion(),
        profile: smokeProfile,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        mcp: mcpSmokeInfo(),
      });
    }
    dialog.showErrorBox("Nexus could not start", `The team database could not be opened.\n\n${message}`);
    app.quit();
    return;
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  try {
    teamSync?.close();
  } catch (error) {
    console.error("[nexus] could not stop team sync", error);
  }
  teamSync = null;
  try {
    team?.close();
  } catch (error) {
    console.error("[nexus] could not flush the team database", error);
  }
  team = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

process.on("unhandledRejection", (reason) => {
  console.error("[nexus] unhandled rejection", reason);
});
