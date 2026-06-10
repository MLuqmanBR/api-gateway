import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, ipcMain, clipboard, nativeTheme } from 'electron';
import { ensureSessionToken, getUnifiedApiKey } from './server.mjs';
import { loadConfig, saveConfig } from './config.js';
import { buildTray } from './tray.js';
import { openDashboard, setQuitting } from './window.js';
import { todayStats, hourlyRequests, successRateToday } from './stats.js';
import { boot, getServerState, getServerPort, stopServer } from './server-control.js';
import { pollNotifications } from './notifications.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Lean posture: one instance, menu-bar only. GPU stays ON — vibrancy
// (the popover/dashboard glass) needs GPU compositing; with hardware
// acceleration disabled, transparent windows render an opaque white.
app.setName('API-Gateway');
app.setPath('userData', path.join(app.getPath('appData'), 'API-Gateway'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let sessionToken = '';
  // The dashboard owns the theme (its navbar toggle); the popover and the
  // window vibrancy follow. Last choice persists in config; before the
  // dashboard has ever reported, fall back to the system appearance —
  // matching the dashboard's own prefers-color-scheme default.
  let theme: 'dark' | 'light' =
    (process.env.API_GATEWAY_THEME as 'dark' | 'light' | undefined)
    ?? loadConfig().theme
    ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  nativeTheme.themeSource = theme;

  app.on('second-instance', () => {
    if (sessionToken) {
      const port = getServerPort();
      if (port != null) openDashboard(port, sessionToken);
    }
  });

  // The app lives in the tray; closing the dashboard window must not quit.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    setQuitting();
  });

  // ── popover IPC ────────────────────────────────────────────────────────

  ipcMain.handle('api-gateway:snapshot', () => {
    const s = todayStats();
    return {
      port: getServerPort(),
      requests: s.requests,
      tokens: s.tokens,
      lastModel: s.lastModel,
      successRate: successRateToday(),
      hourly: hourlyRequests(),
      theme,
      loginItem: app.getLoginItemSettings().openAtLogin,
    };
  });

  ipcMain.on('api-gateway:theme-changed', (_e, next: 'dark' | 'light') => {
    theme = next;
    nativeTheme.themeSource = next;
    saveConfig({ ...loadConfig(), theme: next });
  });

  ipcMain.handle('api-gateway:open-dashboard', () => {
    const port = getServerPort();
    if (port != null) openDashboard(port, sessionToken);
  });

  ipcMain.handle('api-gateway:copy-base-url', () => {
    const port = getServerPort();
    if (port != null) clipboard.writeText(`http://127.0.0.1:${port}/v1`);
  });

  ipcMain.handle('api-gateway:copy-api-key', () =>
    clipboard.writeText(getUnifiedApiKey()),
  );

  ipcMain.handle('api-gateway:set-login-item', (_e, open: boolean) =>
    app.setLoginItemSettings({ openAtLogin: open }),
  );

  ipcMain.handle('api-gateway:quit', async () => {
    setQuitting();
    await stopServer();
    app.quit();
  });

  ipcMain.handle('api-gateway:server-state', () => getServerState());

  ipcMain.handle('api-gateway:open-at-login', () =>
    app.getLoginItemSettings().openAtLogin,
  );

  // ── Startup ────────────────────────────────────────────────────────────

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.hide();

    try {
      const port = await boot(loadConfig());
      sessionToken = ensureSessionToken();
      buildTray();
      console.log(`[desktop] API-Gateway running on http://127.0.0.1:${port}`);

      // Periodic notifications: key exhaustion, error spikes.
      setInterval(() => {
        try { pollNotifications(); } catch { /* best-effort */ }
      }, 60_000);
      // First poll after 30s so the server has time to settle.
      setTimeout(() => {
        try { pollNotifications(); } catch { /* best-effort */ }
      }, 30_000);

      // Auto-updater — check for updates on startup (safe: no-op in dev).
      try {
        const { autoUpdater } = await import('electron-updater');
        autoUpdater.checkForUpdatesAndNotify().catch(() => {
          // Ignore — network unavailable, no releases yet, etc.
        });
      } catch {
        // electron-updater not bundled in dev / optional package.
      }

      // Dev-only UI verification
      if (process.env.API_GATEWAY_SHOT && !app.isPackaged) {
        const fs = await import('node:fs');
        const { togglePopover, getPopoverWindow } = await import('./popover.js');
        const { getDashboardWindow } = await import('./window.js');
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        await sleep(800);
        // The tray was just built — grab it from the popover module path.
        // This is dev-only, so a dynamic import is fine.
        const trayMod = await import('./tray.js');
        togglePopover(trayMod.buildTray as unknown as Electron.Tray);
        if (process.env.API_GATEWAY_SHOT === 'hold') {
          const pop = getPopoverWindow();
          pop?.removeAllListeners('blur');
          if (pop) fs.writeFileSync('/tmp/api-gateway-popover-bounds.json', JSON.stringify(pop.getBounds()));
          if (!process.env.API_GATEWAY_THEME) {
            openDashboard(port, sessionToken);
            await sleep(2500);
            const dashWin = getDashboardWindow();
            if (dashWin) {
              dashWin.show();
              dashWin.focus();
              dashWin.moveTop();
              fs.writeFileSync('/tmp/api-gateway-dashboard-bounds.json', JSON.stringify(dashWin.getBounds()));
            }
          }
          return;
        }
        await sleep(1500);
        const pop = getPopoverWindow()?.webContents.capturePage();
        if (pop) fs.writeFileSync('/tmp/api-gateway-popover.png', (await pop).toPNG());
        openDashboard(port, sessionToken);
        await sleep(3000);
        const dash = getDashboardWindow()?.webContents.capturePage();
        if (dash) fs.writeFileSync('/tmp/api-gateway-dashboard.png', (await dash).toPNG());
        app.quit();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      dialog.showErrorBox('API-Gateway failed to start', msg);
      app.quit();
    }
  });
}
