const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('worldNotice', {
  open: () => ipcRenderer.send('notification-open'),
  close: () => ipcRenderer.send('notification-close'),
  onMessage: callback => ipcRenderer.on('notification-data', (_event, message) => callback(message))
});
