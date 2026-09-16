// Native login items: NSIS installs to a stable executable path on Windows.
class Startup {
  constructor({ app, platform, execPath, config, save }) {
    Object.assign(this, { app, platform, execPath, config, save });
    this.supported = app.isPackaged && ['win32', 'darwin'].includes(platform);
    this.error = null;
  }
  options() { return this.platform === 'win32' ? { path: this.execPath, args: [] } : {}; }
  state() {
    if (!this.supported) return { supported: false, enabled: false, message: 'Disponible dans l’application installée sur Windows ou Mac.' };
    try {
      const settings = this.app.getLoginItemSettings(this.options());
      const enabled = !!settings.openAtLogin && (this.platform !== 'win32' || settings.executableWillLaunchAtLogin !== false) && settings.status !== 'requires-approval';
      let message = enabled ? 'Ouverture à la connexion · mondes vérifiés automatiquement.' : 'Ouverture automatique désactivée.';
      if (settings.status === 'requires-approval') message = 'Autorisez SaveShare dans Réglages Système → Général → Ouverture.';
      else if (!enabled && this.config.launchAtLogin) message = this.platform === 'darwin'
        ? 'macOS n’a pas confirmé l’activation. Ajoutez SaveShare dans Réglages Système → Général → Ouverture (application non signée).'
        : 'Windows a désactivé le démarrage. Vérifiez Paramètres → Applications → Démarrage.';
      return { supported: true, enabled, requested: this.config.launchAtLogin === true, message: this.error || message };
    } catch (e) { return { supported: true, enabled: false, requested: this.config.launchAtLogin === true, message: `Démarrage indisponible : ${e.message}` }; }
  }
  async init() {
    // Register once; never undo a user's later choice in the operating system.
    if (this.supported && this.config.launchAtLogin === undefined) {
      try { await this.set(true); } catch (e) { this.error = e.message; }
    }
  }
  async set(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Réglage de démarrage invalide.');
    if (!this.supported) throw new Error('Installez SaveShare pour configurer le démarrage automatique.');
    this.app.setLoginItemSettings({ ...this.options(), openAtLogin: enabled });
    this.config.launchAtLogin = enabled;
    await this.save(); this.error = null;
    return this.state();
  }
}
module.exports = { Startup };
