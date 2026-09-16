class WorldNotifications {
  constructor({ Notification, enabled, nativeEnabled = enabled, open, announce, fallback = () => {}, onChange = () => {} }) {
    Object.assign(this, { Notification, enabled, nativeEnabled, open, announce, fallback, onChange });
    this.active = new Set();
    this.status = !enabled ? 'Notifications affichées dans SaveShare.' : nativeEnabled && Notification.isSupported() ? 'Notifications de nouvelles sauvegardes activées (selon les autorisations du système).' : 'Petites notifications SaveShare activées.';
  }
  show({ worldId, name }) {
    const message = `Une sauvegarde plus récente de « ${name} » a été téléchargée. Consultez son état dans SaveShare.`;
    this.announce({ worldId, message });
    if (!this.enabled) return;
    if (!this.nativeEnabled || !this.Notification.isSupported()) return this.fallback({ worldId, message });
    const notification = new this.Notification({ title: 'SaveShare · Nouvelle sauvegarde', body: message });
    this.active.add(notification);
    notification.on('click', () => this.open(worldId));
    notification.on('close', () => this.active.delete(notification));
    notification.on('failed', () => { this.active.delete(notification); this.status = 'Notifications système indisponibles · alertes SaveShare utilisées.'; this.fallback({ worldId, message }); this.onChange(); });
    try { notification.show(); } catch { this.active.delete(notification); this.fallback({ worldId, message }); }
  }
}
module.exports = { WorldNotifications };
