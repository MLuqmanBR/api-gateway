import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tray, Menu, app, nativeImage, dialog } from 'electron';
import { togglePopover } from './popover.js';
import { openDashboard } from './window.js';
import { getServerState, getServerPort, restart, stopServer, getServerError, boot } from './server-control.js';
import { ensureSessionToken } from './server-host.js';
import { loadConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;

// Left-click opens the glass popover; right-click shows a full context menu
// with server control, login settings, and quit.
export function buildTray(): Tray {
  const iconPath = path.join(__dirname, '../assets/trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true); // auto light/dark tint in the macOS menu bar

  tray = new Tray(icon);
  tray.setToolTip('FreeLLMAPI — local LLM router');

  tray.on('click', () => togglePopover(tray!));
  tray.on('right-click', () => {
    tray!.popUpContextMenu(buildContextMenu());
  });

  return tray;
}

function buildContextMenu(): Menu {
  const state = getServerState();
  const port = getServerPort();
  const loginSettings = app.getLoginItemSettings();

  const items: Electron.MenuItemConstructorOptions[] = [];

  // ── Status line ────────────────────────────────────────────────────────
  if (state === 'running' && port != null) {
    items.push({ label: `Running on 127.0.0.1:${port}`, enabled: false });
  } else if (state === 'starting') {
    items.push({ label: 'Starting…', enabled: false });
  } else if (state === 'error') {
    items.push({ label: `Error: ${getServerError() ?? 'unknown'}`, enabled: false });
  } else {
    items.push({ label: 'Stopped', enabled: false });
  }

  items.push({ type: 'separator' });

  // ── Dashboard ──────────────────────────────────────────────────────────
  items.push({
    label: 'Open Dashboard',
    enabled: state === 'running',
    click: () => {
      if (port != null) {
        const token = ensureSessionToken();
        openDashboard(port, token);
      }
    },
  });

  items.push({ type: 'separator' });

  // ── Server control ─────────────────────────────────────────────────────
  if (state === 'running') {
    items.push({
      label: 'Restart Server',
      click: async () => {
        try {
          await restart();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          dialog.showErrorBox('Server restart failed', msg);
        }
      },
    });
    items.push({
      label: 'Stop Server',
      click: async () => {
        await stopServer();
      },
    });
  } else if (state === 'stopped' || state === 'error') {
    items.push({
      label: 'Start Server',
      click: async () => {
        try {
          await boot(loadConfig());
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          dialog.showErrorBox('Server start failed', msg);
        }
      },
    });
  }

  items.push({ type: 'separator' });

  // ── Login item toggle ──────────────────────────────────────────────────
  items.push({
    label: 'Start at Login',
    type: 'checkbox',
    checked: loginSettings.openAtLogin,
    click: () => {
      const next = !app.getLoginItemSettings().openAtLogin;
      app.setLoginItemSettings({ openAtLogin: next });
    },
  });

  items.push({ type: 'separator' });

  // ── Quit ───────────────────────────────────────────────────────────────
  items.push({
    label: 'Quit FreeLLMAPI',
    click: async () => {
      await stopServer();
      app.quit();
    },
  });

  return Menu.buildFromTemplate(items);
}
