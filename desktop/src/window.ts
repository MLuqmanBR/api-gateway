import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dashboardWindow: BrowserWindow | null = null;
let quitting = false;

export function getDashboardWindow(): BrowserWindow | null {
  return dashboardWindow;
}

export function setQuitting(): void {
  quitting = true;
}

// One window at a time, hidden on close instead of destroyed — the app
// lives in the tray, the window is an on-demand view. Only truly destroyed
// when the app is quitting. The session token rides in via
// additionalArguments so the CJS preload can seed localStorage before any
// page script runs (no login flash, no reload).
export function openDashboard(port: number, token: string): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'FreeLLMAPI',
    // Native feel: traffic lights float over the app's own header (the client
    // adds a drag region + left padding when it detects the desktop shell),
    // and the window carries a sidebar vibrancy — the strong, Finder-style
    // material — so the client's translucent desktop backdrop (html.desktop
    // in index.css) shows real glass, matching the tray popover. The material
    // follows nativeTheme.themeSource, i.e. the dashboard's own theme.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          vibrancy: 'sidebar' as const,
          visualEffectState: 'followWindow' as const,
          backgroundColor: '#00000000',
        }
      : { backgroundColor: '#09090b' }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      additionalArguments: [`--freeapi-token=${token}`],
    },
  });

  dashboardWindow.loadURL(`http://127.0.0.1:${port}`);

  // Minimize to tray: hide on close instead of destroying, unless we're
  // actually quitting.
  dashboardWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      dashboardWindow?.hide();
    }
  });

  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
}
