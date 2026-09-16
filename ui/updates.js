(() => {
  if (!window.saveShare) return;
  let current;
  const check = document.getElementById('check-updates');
  const apply = document.getElementById('apply-update');
  function update(state) {
    const u = state.update; if (!u) return; current = u;
    document.getElementById('app-version').textContent = `SaveShare ${u.currentVersion}`;
    document.getElementById('footer-version').textContent = `SaveShare · ${u.currentVersion}`;
    const labels = {
      idle: 'Vérification automatique au lancement.', checking: 'Recherche de mises à jour…',
      disabled: 'Mises à jour désactivées en développement.', current: 'Vous avez la dernière version publiée.',
      downloading: `Téléchargement de ${u.version} · ${u.progress} %`, ready: `Version ${u.version} prête à installer.`,
      available: `Version ${u.version} disponible. Sur Mac, installez le téléchargement manuellement.`,
      installing: 'Installation et redémarrage…', error: u.message
    };
    document.getElementById('update-status').textContent = labels[u.status] || '';
    check.disabled = ['checking', 'downloading', 'ready', 'installing', 'disabled'].includes(u.status);
    apply.hidden = !['available', 'ready'].includes(u.status);
    apply.textContent = u.status === 'ready' ? 'Redémarrer et installer' : 'Ouvrir le téléchargement';
    apply.disabled = u.status === 'ready' && (state.busy || state.worlds.some(w => w.active));
    apply.title = apply.disabled ? 'Terminez votre session et la synchronisation pour installer.' : '';
  }
  check.onclick = async () => { try { await window.saveShare.checkUpdates(); } catch (e) { toast(e.message); } };
  apply.onclick = async () => { try { if (current.status === 'ready') await window.saveShare.installUpdate(); else await window.saveShare.openUpdate(); } catch (e) { toast(e.message); } };
  window.saveShare.onState(update);
  window.saveShare.state().then(update).catch(e => toast(e.message));
})();
