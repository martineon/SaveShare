const semver = require('semver');
const RELEASES = 'https://github.com/martineon/SaveShare/releases';

function installBlockReason(clientState, gameRunning) {
  if (clientState.busy) return 'Attendez la fin de la synchronisation avant de mettre à jour SaveShare.';
  if (clientState.worlds.some(w => w.active)) return 'Terminez votre session avant de mettre à jour SaveShare.';
  if (gameRunning) return 'Fermez Valheim avant de mettre à jour SaveShare.';
  return null;
}

class Updates {
  constructor({ updater, version, packaged, platform, onChange = () => {}, openExternal }) {
    this.updater = updater;
    this.packaged = packaged;
    this.automatic = platform === 'win32';
    this.onChange = onChange;
    this.openExternal = openExternal;
    this.value = { currentVersion: version, status: packaged ? 'idle' : 'disabled', automatic: this.automatic, version: null, progress: 0, message: null };
    updater.autoDownload = this.automatic;
    // Never let ordinary app shutdown install over a pending game session.
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.on('checking-for-update', () => this.set({ status: 'checking', message: null }));
    updater.on('update-not-available', () => this.set({ status: 'current', version: null, progress: 0, message: null }));
    updater.on('update-available', info => {
      if (!semver.valid(info.version) || !semver.gt(info.version, version)) return;
      this.set({ status: this.automatic ? 'downloading' : 'available', version: info.version, progress: 0, message: null });
    });
    updater.on('download-progress', info => {
      const progress = Math.max(0, Math.min(100, Math.floor(info.percent || 0)));
      if (progress !== this.value.progress) this.set({ status: 'downloading', progress });
    });
    updater.on('update-downloaded', info => this.set({ status: 'ready', version: info.version, progress: 100, message: null }));
    updater.on('error', () => this.failed());
  }
  get installing() { return this.value.status === 'installing'; }
  state() { return { ...this.value }; }
  set(value) { this.value = { ...this.value, ...value }; this.onChange(); }
  failed() { this.set({ status: 'error', message: 'La mise à jour a échoué. Votre version actuelle reste utilisable. Vérifiez votre connexion puis réessayez.' }); }
  async check() {
    if (!this.packaged || ['checking', 'downloading', 'ready', 'installing'].includes(this.value.status)) return this.state();
    this.set({ status: 'checking', message: null });
    try {
      const result = await this.updater.checkForUpdates();
      if (result?.downloadPromise) await result.downloadPromise;
    } catch { this.failed(); }
    return this.state();
  }
  async openDownload() {
    if (!this.value.version || !semver.valid(this.value.version)) throw new Error('Vérifiez d’abord si une mise à jour est disponible.');
    await this.openExternal(`${RELEASES}/tag/v${encodeURIComponent(this.value.version)}`);
  }
  install() {
    if (!this.automatic || this.value.status !== 'ready') throw new Error('Aucune mise à jour prête à installer.');
    this.set({ status: 'installing' });
    try { this.updater.quitAndInstall(false, true); }
    catch (e) { this.failed(); throw e; }
  }
}
module.exports = { Updates, installBlockReason };
