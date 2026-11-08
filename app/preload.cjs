// Minimal, read-only bridge for the desktop shell.
//
// The game itself never needs privileged APIs, so this exposes exactly one
// capability: telling the main process to quit (the in-game "ÇIKIŞ" button
// cannot close a window from a sandboxed renderer by itself).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SIFIR_NOKTA_DESKTOP', {
  isDesktop: true,
  quit: () => ipcRenderer.send('app:quit'),
});
