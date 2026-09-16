const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('saveShare', {
  state: () => ipcRenderer.invoke('state'),
  chooseFolder: mode => ipcRenderer.invoke('choose-folder', mode),
  add: input => ipcRenderer.invoke('add', input),
  action: (world, action, version) => ipcRenderer.invoke('action', world, action, version),
  refresh: () => ipcRenderer.invoke('refresh'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  openUpdate: () => ipcRenderer.invoke('open-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onState: callback => { ipcRenderer.on('state', (_event, state) => callback(state)); }
});
