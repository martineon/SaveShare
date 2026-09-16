const path = require('node:path');
function createWorldPopup({ BrowserWindow, screen, open }) {
  let popup;
  return ({ worldId, message }) => {
    if (popup && !popup.isDestroyed()) popup.close();
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(360, area.width), height = 150;
    const win = new BrowserWindow({ width, height, x: area.x + area.width - width - 16, y: area.y + 20, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#171e2b', webPreferences: { preload: path.join(__dirname, 'popup-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    popup = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('ipc-message', (_event, channel) => {
      if (channel === 'notification-open') { open(worldId); win.close(); }
      else if (channel === 'notification-close') win.close();
    });
    const timer = setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 10_000);
    win.on('closed', () => clearTimeout(timer));
    win.loadFile(path.join(__dirname, '../ui/popup.html')).then(() => {
      if (!win.isDestroyed()) { win.webContents.send('notification-data', message); win.showInactive(); }
    }).catch(() => { if (!win.isDestroyed()) win.close(); });
  };
}
module.exports = { createWorldPopup };
