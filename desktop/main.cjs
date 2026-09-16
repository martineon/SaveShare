const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Notification, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('./client.cjs');
const { Updates, installBlockReason } = require('./updates.cjs');
const { Startup } = require('./startup.cjs');
const { WorldNotifications } = require('./notifications.cjs');
const { createWorldPopup } = require('./world-popup.cjs');
const { diagnose } = require('./diagnostics.cjs');
const run = promisify(execFile);
let win, client, updates, startup, notifications, closing = false, installingUpdate = false;
const selectedFolders = new Set();
const diagnosticReports = new Map();
const page = path.join(__dirname, '../ui/index.html');
async function isGameRunning() {
  if (process.env.SAVESHARE_TEST_MODE === '1') return false;
  if (process.platform === 'win32') {
    const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 });
    return /"valheim(?:_server)?\.exe"/i.test(stdout);
  }
  const { stdout } = await run('/bin/ps', ['-axo', 'comm='], { timeout: 5000 });
  return stdout.split('\n').some(line => /^(valheim|valheim_server)(?:\.exe)?$/i.test(path.basename(line.trim())));
}
function state() { return { ...client.state(), update: updates?.state(), startup: startup?.state(), notificationStatus: notifications?.status }; }
function notify() { if (win && !win.isDestroyed()) win.webContents.send('state', state()); }
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(page).href) throw new Error('Source non autorisée.');
    if (updates?.installing && name !== 'state') throw new Error('SaveShare redémarre pour installer la mise à jour.');
    return fn(...args);
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('app.saveshare.desktop');
    const openWorld = worldId => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore(); win.show(); win.focus();
      win.webContents.send('select-world', worldId);
    };
    notifications = new WorldNotifications({ Notification, enabled: app.isPackaged && process.env.SAVESHARE_TEST_MODE !== '1', nativeEnabled: process.platform === 'win32', open: openWorld, fallback: createWorldPopup({ BrowserWindow, screen, open: openWorld }), onChange: notify, announce: data => { if (win && !win.isDestroyed()) win.webContents.send('world-notification', data); } });
    client = await new Client({ dataDir: process.env.SAVESHARE_TEST_DATA || app.getPath('userData'), isGameRunning, onChange: notify, onNewVersion: data => notifications.show(data) }).init();
    startup = new Startup({ app, platform: process.platform, execPath: process.execPath, config: client.config, save: () => client.save() });
    await startup.init();
    handle('set-startup', enabled => client.exclusive(() => startup.set(enabled)));
    updates = new Updates({ updater: require('electron-updater').autoUpdater, version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, openExternal: url => shell.openExternal(url), onChange: () => {
      if (installingUpdate && !updates.installing) { installingUpdate = false; closing = false; }
      notify();
    } });
    handle('state', state);
    handle('diagnose-world', wid => client.exclusive(async () => {
      diagnosticReports.delete(wid);
      const result = await diagnose(client, wid, { version: app.getVersion(), home: app.getPath('home') });
      diagnosticReports.set(wid, result.report); return result;
    }));
    handle('copy-diagnostic', wid => {
      client.get(wid);
      const report = diagnosticReports.get(wid);
      if (!report) throw new Error('Lancez le diagnostic avant de copier le rapport.');
      clipboard.writeText(report); return 'Rapport masqué copié. Vous pouvez le partager.';
    });
    handle('check-updates', () => updates.check());
    handle('open-update', () => updates.openDownload());
    handle('install-update', async () => {
      const initial = installBlockReason(client.state(), false);
      if (initial) throw new Error(initial);
      return client.exclusive(async () => {
        const reason = installBlockReason({ ...client.state(), busy: false }, await isGameRunning());
        if (reason) throw new Error(reason);
        if (updates.state().status !== 'ready' || !updates.automatic) throw new Error('Aucune mise à jour prête à installer.');
        closing = true; installingUpdate = true;
        updates.install();
      });
    });
    handle('choose-folder', async mode => {
      if (!['create', 'legacy', 'join'].includes(mode)) throw new Error('Sélection invalide.');
      const base = process.platform === 'win32' ? path.join(app.getPath('home'), 'AppData/LocalLow/IronGate/Valheim/worlds_local') : path.join(app.getPath('home'), 'Library/Application Support/IronGate/Valheim/worlds_local');
      const result = await dialog.showOpenDialog(win, { title: mode === 'create' ? 'Choisir le dossier du monde dans worlds_local' : mode === 'legacy' ? 'Ancien format : choisir le fichier .fwl' : 'Choisir le dossier worlds_local de Valheim', defaultPath: base, properties: [mode === 'legacy' ? 'openFile' : 'openDirectory'], ...(mode === 'legacy' ? { filters: [{ name: 'Ancien monde Valheim', extensions: ['fwl'] }] } : {}) });
      if (result.canceled) return null;
      const chosen = result.filePaths[0]; const folder = mode === 'join' ? chosen : path.dirname(chosen);
      selectedFolders.add(folder); return { folder, fileStem: mode === 'join' ? '' : path.basename(chosen, mode === 'legacy' ? '.fwl' : undefined), selection: mode };
    });
    handle('add', input => client.exclusive(async () => {
      if (!input || !selectedFolders.has(input.folder)) throw new Error('Sélectionnez le dossier avec le bouton Parcourir.');
      return client.add(input);
    }));
    handle('action', (wid, action, version) => client.exclusive(async () => {
      const w = client.get(wid), r = client.stateFor(w);
      if (action === 'start') return client.start(wid);
      if (action === 'finish') return client.finish(wid);
      if (action === 'publish') return client.publish(wid, 'Sauvegarde manuelle', true);
      if (action === 'pull' || action === 'restore') {
        const result = await dialog.showMessageBox(win, { type: 'warning', title: 'Valheim doit être fermé', message: action === 'restore' ? 'Restaurer cette version pour tout le groupe ?' : 'Appliquer la dernière version partagée ?', detail: 'Confirmez que Valheim est fermé. Votre sauvegarde locale sera copiée dans un dossier de secours avant remplacement. Une restauration reste visible dans l’historique.', buttons: ['Annuler', 'Jeu fermé, continuer'], defaultId: 0, cancelId: 0 });
        if (result.response !== 1) return;
        return action === 'restore' ? client.restore(wid, version) : client.pull(wid, true);
      }
      if (action === 'auto') {
        if (r.session) throw new Error('Terminez la session avant d’activer la réception.');
        if (!r.autoApply) {
          const result = await dialog.showMessageBox(win, { type: 'question', message: 'Autoriser l’application des sauvegardes reçues ?', detail: 'Ce réglage reste activé au redémarrage. Les versions reçues sont appliquées uniquement jeu fermé, hors session et sans modifications locales. Prenez la session dans SaveShare avant de lancer votre monde.', buttons: ['Annuler', 'Autoriser'], defaultId: 0, cancelId: 0 });
          if (result.response !== 1) return;
        }
        await client.setAutoApply(wid, !r.autoApply); return;
      }
      if (action === 'invite') { clipboard.writeText(client.invitation(wid)); return 'Invitation copiée. Elle donne accès en lecture et écriture à ce monde.'; }
      if (action === 'folder' || action === 'backup') {
        const target = action === 'backup' ? w.backup : w.folder;
        if (!target) throw new Error('Aucune copie de secours pour ce monde.');
        const err = await shell.openPath(target); if (err) throw new Error(err); return;
      }
      throw new Error('Action inconnue.');
    }));
    handle('refresh', () => client.tick());
    win = new BrowserWindow({ width: 1240, height: 840, minWidth: 960, minHeight: 680, backgroundColor: '#0c1018', title: 'SaveShare', titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    await win.loadFile(page);
    const poll = setInterval(() => { if (!updates.installing) client.tick().catch(console.error); }, 15_000);
    const heartbeat = setInterval(() => client.renew().catch(console.error), 20_000);
    const firstUpdateCheck = setTimeout(() => updates.check(), 10_000);
    const updateChecks = setInterval(() => updates.check(), 6 * 60 * 60_000);
    client.tick().catch(console.error);
    win.on('close', event => {
      if (closing || (!client.busy && !client.config.worlds.some(w => client.stateFor(w).session))) return;
      event.preventDefault();
      dialog.showMessageBox(win, { type: 'warning', message: 'SaveShare travaille encore ou une session est ouverte.', detail: 'Terminez votre session après avoir fermé Valheim pour envoyer la dernière sauvegarde. En quittant maintenant, vos fichiers locaux restent conservés, mais la synchronisation s’arrête.', buttons: ['Rester', 'Quitter quand même'], defaultId: 0, cancelId: 0 }).then(result => { if (result.response === 1) { closing = true; win.close(); } });
    });
    win.on('closed', () => { clearInterval(poll); clearInterval(heartbeat); clearTimeout(firstUpdateCheck); clearInterval(updateChecks); app.quit(); });
  }).catch(err => { dialog.showErrorBox('SaveShare ne peut pas démarrer', err.message); app.quit(); });
}
