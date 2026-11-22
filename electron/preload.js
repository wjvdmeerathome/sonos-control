'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sonosApp', {
  showMain: () => ipcRenderer.send('show-main'),
  hideMini: () => ipcRenderer.send('hide-mini'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, !!value),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  onUpdateStatus: cb => ipcRenderer.on('update-status', (e, s) => cb(s)),
  checkForUpdates: () => ipcRenderer.send('check-updates'),
  installUpdate: () => ipcRenderer.send('install-update'),
});
