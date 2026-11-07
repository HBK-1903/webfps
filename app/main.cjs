// SIFIR NOKTA — Electron desktop shell (Windows / macOS / Linux).
//
// Loads the offline single-file build (dist/SifirNokta.html) in a chrome-less
// window tuned for a first-person shooter: fixed aspect, no menu bar, no
// background throttling (a hidden window must not slow the game's loop down),
// pointer lock allowed, and a hard block on navigating away.
//
// Security posture: the renderer is a plain page. Node stays off, context
// isolation on, sandbox on, and the only bridge is the tiny quit/preload pair in
// preload.cjs. Nothing in the game needs privileged access, so nothing gets it.
'use strict';

const { app, BrowserWindow, Menu, shell, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'dist', 'SifirNokta.html');
const ICON = path.join(ROOT, 'build', 'icon.ico');
const IS_DEV = process.argv.includes('--dev');

// Only one instance: two windows would fight over the pointer and over the
// settings file, which reads as "the game is broken".
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;

function createWindow() {
  // Fit the window to the display: a 1600x900 window on a 1366x768 laptop is
  // unusable, and the game's HUD scales with the viewport anyway.
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1600, Math.round(width * 0.92));
  const h = Math.min(900, Math.round(height * 0.92));

  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#0b0f12',
    title: 'SIFIR NOKTA',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    show: false, // avoid a white flash before the first frame is drawn
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // The game is local; no remote content is ever loaded.
      webSecurity: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });

  // Anything that is not our own file:// page opens in the real browser instead
  // of stealing the game window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => null);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url).catch(() => null);
    }
  });

  win.loadFile(GAME);

  if (IS_DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // F11 fullscreen, Ctrl+R reload, F12 devtools — the keys a player expects
  // from a desktop build. Registered on the window, not globally.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
      win.reload();
      event.preventDefault();
    } else if ((input.control || input.meta) && input.key.toLowerCase() === 'q') {
      app.quit();
      event.preventDefault();
    }
  });
}

ipcMain.on('app:quit', () => app.quit());

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (!fs.existsSync(GAME)) {
    // A readable error beats a blank window.
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'SIFIR NOKTA',
      `Oyun dosyası bulunamadı:\n${GAME}\n\nProje klasöründe "npm run build" çalıştırın.`,
    );
    app.quit();
    return;
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
