const $ = id => document.getElementById(id);
const api = window.saveShare;
let state = { worlds: [], author: 'Viking', busy: false }, selected = null, mode = 'create', chosen = null, toastTimer;
const esc = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const date = raw => new Date(raw).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const bytes = n => n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} Mo` : `${Math.ceil(n / 1024)} Ko`;
function toast(message) { $('toast').textContent = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 7000); }
function openSetup() { $('author').value = state.author; $('setup').showModal(); }
function setMode(value) { mode = value; chosen = null; $('tab-create').classList.toggle('selected', mode === 'create'); $('tab-join').classList.toggle('selected', mode === 'join'); $('create-fields').hidden = mode !== 'create'; $('join-fields').hidden = mode !== 'join'; $('choose-legacy').hidden = mode !== 'create'; $('folder-value').textContent = mode === 'create' ? 'Choisir le dossier du monde dans worlds_local' : 'Choisir le dossier worlds_local'; $('submit-world').textContent = mode === 'create' ? 'Créer le partage →' : 'Rejoindre le monde →'; $('form-error').textContent = ''; }
function render(next) {
  state = next; if (!selected || !state.worlds.some(w => w.id === selected)) selected = state.worlds[0]?.id;
  $('count').textContent = state.worlds.length;
  $('profile').innerHTML = `${esc(state.author)}<small>Sur cet ordinateur</small>`; $('avatar').textContent = state.author.slice(0, 1).toUpperCase();
  $('world-list').innerHTML = state.worlds.map(w => `<button class="world-link ${w.id === selected ? 'selected' : ''}" data-world="${esc(w.id)}">${esc(w.name)}</button>`).join('');
  $('world-list').querySelectorAll('button').forEach(btn => btn.onclick = () => { selected = btn.dataset.world; render(state); });
  const w = state.worlds.find(w => w.id === selected);
  if (!w) {
    $('content').innerHTML = `<div class="page-heading"><div><h1>Mes mondes</h1><p>Vos aventures continuent, même quand l’hôte change.</p></div><button class="primary" data-add>＋ Ajouter un monde</button></div><div class="empty"><div class="empty-emblem">⌘</div><div class="eyebrow">VALHEIM · WINDOWS & MAC</div><h2>Le même monde. Toute votre tribu.</h2><p>Partagez votre sauvegarde, retrouvez chaque version et passez le relais à vos amis. Votre prochain départ commence ici.</p><button class="primary" data-add>Connecter mon premier monde <span>→</span></button></div><div class="steps"><div class="step"><span>01 / CONNECTER</span><h3>Votre monde, votre serveur</h3><p>Reliez votre sauvegarde locale à un serveur SaveShare et invitez vos amis.</p></div><div class="step"><span>02 / JOUER</span><h3>Prenez le relais</h3><p>Réservez la session avant de lancer Valheim. Vos sauvegardes sont envoyées automatiquement.</p></div><div class="step"><span>03 / RETROUVER</span><h3>Aucune aventure oubliée</h3><p>Vos amis reçoivent les nouvelles versions. Revenez à une ancienne sauvegarde au besoin.</p></div></div><div class="notice">Le serveur SaveShare stocke les sauvegardes ; la partie Valheim reste hébergée sur le PC du joueur qui prend la session. Un serveur HTTPS est nécessaire pour jouer entre amis à distance.</div>`;
  } else {
    const remote = w.remote, versions = remote?.versions || [], latest = versions[0], lease = remote?.lease;
    const status = w.active ? 'Vous avez la session' : lease ? `Session de ${lease.author}` : 'Prêt à passer le relais';
    $('content').innerHTML = `<div class="page-heading"><div><h1>Mes mondes</h1><p>La progression est collective. La prochaine session est à vous.</p></div><button class="primary" data-add>＋ Ajouter un monde</button></div><div class="hero"><div class="hero-content"><div class="game-tag"><span>◆</span> VALHEIM <span> / </span> MONDE PARTAGÉ</div><h2>${esc(w.name)}</h2><span class="badge"><i class="online-dot"></i>${esc(status)}</span><div class="hero-bottom"><span>${esc(w.fileStem)} · ${esc(versions.length)} version${versions.length > 1 ? 's' : ''} conservée${versions.length > 1 ? 's' : ''}</span><div class="hero-buttons"><button data-action="invite">↗ Inviter un ami</button><button class="primary" data-action="${w.active ? 'finish' : 'start'}" ${!w.active && lease ? 'disabled' : ''}>${w.active ? 'Terminer ma session' : 'Prendre la session'} <span>→</span></button></div></div></div></div>${w.error ? `<div class="notice warning" role="alert">${esc(w.error)}</div>` : ''}<div class="stats"><div class="stat"><div class="stat-label">SYNCHRONISATION</div><div class="stat-value ${w.error ? '' : 'good'}">${w.error ? 'À vérifier' : w.base && w.base === remote?.head ? 'À jour' : 'En attente'}<small>${esc(w.status)}</small></div></div><div class="stat"><div class="stat-label">DERNIÈRE SAUVEGARDE</div><div class="stat-value">${latest ? esc(date(latest.createdAt)) : 'Aucune'}<small>${latest ? `par ${esc(latest.author)}` : 'Prenez la session pour publier'}</small></div></div><div class="stat"><div class="stat-label">TAILLE DU MONDE</div><div class="stat-value">${latest ? bytes(latest.files.reduce((n, f) => n + f.size, 0)) : '—'}<small>${latest?.files.length ?? '—'} fichiers · ${latest?.format === 'folder' ? 'dossier Valheim' : 'ancien format'}</small></div></div></div><div class="section-head"><div><h3>Historique des sauvegardes</h3><p>Chaque étape de votre aventure reste accessible.</p></div><button class="quiet" data-action="${w.active ? 'publish' : 'pull'}">${w.active ? '↑ Sauvegarder maintenant' : '↓ Récupérer'}</button></div><div class="history">${versions.length ? versions.slice(0, 30).map((v, i) => `<div class="history-row"><div class="commit-icon">⌁</div><div class="commit-main"><strong>${esc(v.message)}</strong>${i === 0 ? '<span class="latest">DERNIÈRE VERSION</span>' : ''}<p><code>${esc(v.id.slice(0, 8))}</code>${esc(v.author)} · ${esc(date(v.createdAt))} · ${bytes(v.files.reduce((n, f) => n + f.size, 0))}</p></div>${i > 0 ? `<button data-action="restore" data-version="${esc(v.id)}" ${w.active ? 'disabled' : ''}>Restaurer ↶</button>` : ''}</div>`).join('') : '<div class="history-row"><p>Aucune sauvegarde publiée. Prenez votre première session, jeu fermé.</p></div>'}</div><div class="settings-card"><div><strong>Appliquer automatiquement les versions reçues</strong><p>À l’ouverture et en continu · jeu fermé · progression locale protégée · réglage mémorisé</p></div><button aria-label="Réception automatique" role="switch" aria-checked="${w.autoApply}" class="toggle ${w.autoApply ? 'on' : ''}" data-action="auto" ${w.active ? 'disabled' : ''}></button></div><div class="section-head"><p class="path">⌁ ${esc(w.folder)}</p><div><button class="quiet" data-action="diagnose">Diagnostiquer ce monde</button><button class="quiet" data-action="folder">Ouvrir</button>${w.backup ? '<button class="quiet" data-action="backup">Copie de secours</button>' : ''}</div></div>`;
    $('content').querySelectorAll('[data-action]').forEach(btn => { btn.disabled ||= state.busy; btn.onclick = async () => { try { if (btn.dataset.action === 'diagnose') { await openDiagnostics(w.id); return; } const result = await api.action(w.id, btn.dataset.action, btn.dataset.version); if (typeof result === 'string') toast(result); render(await api.state()); } catch (e) { toast(e.message); } }; });
  }
  $('content').querySelectorAll('[data-add]').forEach(btn => btn.onclick = openSetup);
  $('refresh').disabled = state.busy;
}
$('add-nav').onclick = openSetup;
$('worlds-nav').onclick = () => render(state);
$('close-dialog').onclick = () => $('setup').close();
$('tab-create').onclick = () => setMode('create');
$('tab-join').onclick = () => setMode('join');
async function chooseWorld(selection) { try { const result = await api.chooseFolder(selection); if (result) { chosen = result; $('folder-value').textContent = result.folder + (result.fileStem ? ` / ${result.fileStem}${result.selection === 'legacy' ? '.fwl' : '/'}` : ''); if (!$('name').value && result.fileStem) $('name').value = result.fileStem; } } catch (e) { toast(e.message); } };
$('choose-folder').onclick = () => chooseWorld(mode);
$('choose-legacy').onclick = () => chooseWorld('legacy');
$('setup-form').onsubmit = async event => {
  event.preventDefault(); $('form-error').textContent = '';
  if (!chosen) { $('form-error').textContent = 'Choisissez votre sauvegarde locale avec Parcourir.'; return; }
  if (mode === 'join' && !$('invite').value.trim()) { $('form-error').textContent = 'Collez le code d’invitation fourni par votre ami.'; return; }
  $('submit-world').disabled = true;
  try {
    selected = await api.add({ ...chosen, author: $('author').value, server: $('server').value, adminToken: $('admin-token').value, name: $('name').value, invite: mode === 'join' ? $('invite').value : undefined });
    $('admin-token').value = ''; $('invite').value = ''; $('setup').close(); render(await api.state()); toast('Monde connecté. Prenez la session ou récupérez la dernière version.');
  } catch (e) { $('form-error').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  finally { $('submit-world').disabled = false; }
};
$('refresh').onclick = async () => { try { await api.refresh(); render(await api.state()); } catch (e) { toast(e.message); } };
if (api) { api.onState(render); api.state().then(render).catch(e => toast(e.message)); }
else { render(state); toast('Ouvrez cette interface depuis l’application SaveShare avec npm start.'); }
