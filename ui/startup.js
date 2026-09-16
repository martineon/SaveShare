(() => {
  if (!window.saveShare) return;
  const toggle = document.getElementById('launch-at-login');
  let pending = false;
  function renderStartup(state) {
    const s = state.startup;
    toggle.checked = s?.requested ?? !!s?.enabled;
    toggle.disabled = pending || !s?.supported || state.busy;
    document.getElementById('startup-status').textContent = s?.message || '';
    document.getElementById('notification-status').textContent = state.notificationStatus || '';
  }
  toggle.onchange = async () => {
    pending = true; toggle.disabled = true;
    try { await window.saveShare.setStartup(toggle.checked); }
    catch (e) { toast(e.message); }
    finally { pending = false; renderStartup(await window.saveShare.state()); }
  };
  window.saveShare.onState(renderStartup);
  window.saveShare.onNewVersion(data => toast(data.message));
  window.saveShare.onSelectWorld(worldId => { selected = worldId; render(state); });
  window.saveShare.state().then(renderStartup).catch(e => toast(e.message));
})();
