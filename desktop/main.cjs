const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('./client.cjs');
const { Updates, installBlockReason } = require('./updates.cjs');
const run = promisify(execFile);
let win, client, updates, closing = false, installingUpdate = false;
const selectedFolders = new Set();
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
function state() { return { ...client.state(), update: updates?.state() }; }
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
    client = await new Client({ dataDir: process.env.SAVESHARE_TEST_DATA || app.getPath('userData'), isGameRunning, onChange: notify }).init();
    updates = new Updates({ updater: require('electron-updater').autoUpdater, version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, openExternal: url => shell.openExternal(url), onChange: () => {
      if (installingUpdate && !updates.installing) { installingUpdate = false; closing = false; }
      notify();
    } });
    handle('state', state);
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
      const base = process.platform === 'win32' ? path.join(app.getPath('home'), 'AppData/LocalLow/IronGate/Valheim/worlds_local') : path.join(app.getPath('home'), 'Library/Application Support/IronGate/Valheim/worlds_local');
      const result = await dialog.showOpenDialog(win, { title: mode === 'create' ? 'Choisir le fichier .fwl du monde Valheim' : 'Choisir le dossier worlds_local de Valheim', defaultPath: base, properties: [mode === 'create' ? 'openFile' : 'openDirectory'], ...(mode === 'create' ? { filters: [{ name: 'Monde Valheim', extensions: ['fwl'] }] } : {}) });
      if (result.canceled) return null;
      const chosen = result.filePaths[0]; const folder = mode === 'create' ? path.dirname(chosen) : chosen;
      selectedFolders.add(folder); return { folder, fileStem: mode === 'create' ? path.basename(chosen, '.fwl') : '' };
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
          const result = await dialog.showMessageBox(win, { type: 'question', message: 'Autoriser l’application des sauvegardes reçues ?', detail: 'Gardez Valheim fermé sur ce PC. Prenez la session dans SaveShare avant de lancer votre propre monde. Les fichiers locaux modifiés ne seront jamais remplacés automatiquement.', buttons: ['Annuler', 'Autoriser'], defaultId: 0, cancelId: 0 });
          if (result.response !== 1) return;
        }
        r.autoApply = !r.autoApply; return;
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
