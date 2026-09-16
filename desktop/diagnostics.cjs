const fs = require('node:fs/promises');
const { constants, createReadStream } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { inventory, unchanged } = require('./snapshots.cjs');
const { manifest, isId } = require('../shared/common.cjs');

function usualFolder(platform, home) {
  return platform === 'win32' ? path.win32.join(home, 'AppData/LocalLow/IronGate/Valheim/worlds_local')
    : platform === 'darwin' ? path.posix.join(home, 'Library/Application Support/IronGate/Valheim/worlds_local')
      : path.join(home, '.config/unity3d/IronGate/Valheim/worlds_local');
}
const readableError = e => ['ENOENT', 'ENOTDIR'].includes(e.code) ? 'absent' : ['EACCES', 'EPERM'].includes(e.code) ? 'accès refusé' : 'lecture impossible';
const shortVersion = v => isId(v) ? v : 'aucune';
function sharedPath(value, stem) {
  const parts = value.replaceAll('\\', '/').split('/');
  const index = parts.findIndex(p => p.toLowerCase() === 'worlds_local');
  const suffix = index < 0 ? parts.slice(-1) : parts.slice(index);
  return '<emplacement masqué>/' + suffix.map(p => p === stem ? '<monde>' : p === `${stem}.db` ? '<monde>.db' : p === `${stem}.fwl` ? '<monde>.fwl' : p.toLowerCase() === 'worlds_local' ? 'worlds_local' : '<dossier>').join('/');
}
function sharedFilename(name, stem) {
  return name.split('/').map(p => p === stem ? '<monde>' : p === `${stem}.db` ? '<monde>.db' : p === `${stem}.fwl` ? '<monde>.fwl' : /^(_main\.\d+\.(db2|fwl2|chunks|ok)|[a-f\d_-]+\.chunk)$/i.test(p) ? p : '<autre fichier>').join('/');
}
function compare(actual, expected) {
  const byName = new Map(actual.map(f => [f.name, f]));
  const expectedNames = new Set(expected.map(f => f.name));
  const result = { missing: [], changed: [], extra: actual.filter(f => !expectedNames.has(f.name)).map(f => f.name), unverified: 0, matched: 0 };
  for (const f of expected) {
    const got = byName.get(f.name);
    if (!got) result.missing.push(f.name);
    else if (got.size !== f.size || (got.hash && got.hash !== f.hash)) result.changed.push(f.name);
    else if (!got.hash) result.unverified++;
    else result.matched++;
  }
  result.identical = !result.missing.length && !result.changed.length && !result.extra.length && !result.unverified;
  return result;
}
async function diagnose(client, wid, { version, platform = process.platform, home = os.homedir(), hashBudget = 512 * 1024 ** 2, timeoutMs = 30_000 } = {}) {
  const w = client.get(wid), runtime = client.stateFor(w);
  const checks = [];
  const add = (code, level, title, detail) => checks.push({ code, level, title, detail });
  const result = { generatedAt: new Date().toISOString(), appVersion: version, platform, worldId: w.id, paths: { configured: w.folder, usual: usualFolder(platform, home), destination: path.join(w.folder, w.fileStem) }, versions: { local: shortVersion(w.base), remote: 'inconnue', format: 'inconnu' }, checks };
  const deadline = Date.now() + timeoutMs;
  let budget = hashBudget, hashedBytes = 0;
  async function fingerprint(filename, size) {
    if (size > budget || Date.now() >= deadline) return null;
    budget -= size;
    const sha = crypto.createHash('sha256');
    const stream = createReadStream(filename, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    try { for await (const chunk of stream) { sha.update(chunk); hashedBytes += chunk.length; } return sha.digest('hex'); }
    catch (e) { if (e.name === 'AbortError') return null; throw e; }
  }
  let remote;
  try {
    // GET only; do not call info(), tick(), cache(), recover() or save().
    const response = await fetch(`${w.server}/worlds/${w.id}`, { headers: { Authorization: `Bearer ${w.key}`, 'x-saveshare-protocol': '2' }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) {
      add('server', 'error', 'Serveur inaccessible', response.status === 401 ? 'Invitation refusée (HTTP 401).' : response.status === 426 ? 'Mise à jour de SaveShare nécessaire (HTTP 426).' : `Réponse HTTP ${response.status}.`);
    } else {
      const data = await response.json();
      if (data.id !== w.id || data.fileStem !== w.fileStem || !Array.isArray(data.versions) || (data.head && (!isId(data.head) || data.head !== data.versions[0]?.id))) throw Error('Invalid metadata');
      const latest = data.head ? data.versions[0] : null;
      remote = { head: data.head, latest: latest && { id: latest.id, format: latest.format || 'legacy', files: manifest(latest.files, w.fileStem, latest.format) } };
      result.versions.remote = shortVersion(remote.head); result.versions.format = remote.latest?.format || 'aucune';
      add('server', 'ok', 'Serveur joignable', remote.head ? 'Dernière version consultée en lecture seule.' : 'Aucune sauvegarde publiée : l’hôte doit publier sa première version.');
    }
  } catch { add('server', 'error', 'Serveur non vérifié', 'Connexion impossible, délai dépassé ou réponse invalide. Les autres contrôles restent disponibles.'); }
  try {
    const playing = await client.isGameRunning();
    add('game', playing ? 'warning' : 'ok', playing ? 'Valheim est ouvert' : 'Valheim non détecté', playing ? 'Les fichiers reçus restent dans le cache tant que le jeu ou son serveur tourne.' : 'Les exécutables renommés et les serveurs distants ne peuvent pas être détectés.');
  } catch { add('game', 'warning', 'État de Valheim inconnu', 'La détection des processus a échoué ; les remplacements automatiques sont bloqués.'); }
  add('session', runtime.session ? 'warning' : 'ok', runtime.session ? 'Session d’écriture active' : 'Aucune session d’écriture locale', runtime.session ? 'La réception automatique est suspendue pendant votre session.' : 'Rejoindre un partage SaveShare ne lance pas une partie Valheim.');
  add('auto', runtime.autoApply ? 'ok' : 'warning', runtime.autoApply ? 'Réception automatique activée' : 'Application automatique désactivée', runtime.autoApply ? 'Application uniquement jeu fermé et sans progression locale non publiée.' : 'Les fichiers peuvent être téléchargés sans être installés dans le dossier du jeu.');
  let rootNames = [], rootSafe = false;
  try {
    const stat = await fs.lstat(w.folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe folder');
    rootSafe = true;
    rootNames = await fs.readdir(w.folder);
    await fs.access(w.folder, constants.R_OK | constants.W_OK);
    add('permissions', 'ok', 'Dossier accessible', 'Contrôle indicatif lecture/écriture, sans création de fichier. Les verrous Windows et certaines ACL peuvent encore empêcher un remplacement.');
  } catch (e) { add('permissions', 'error', 'Dossier non utilisable', `Dossier ${readableError(e)}. Aucun fichier créé pour tester les permissions.`); }
  const normalized = s => s.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const configured = normalized(w.folder), usual = normalized(result.paths.usual);
  if (configured === usual) add('path', 'ok', 'Chemin habituel sélectionné', 'Ce chemin correspond au dossier local habituel, mais ne prouve pas que cette installation de Valheim l’utilise.');
  else add('path', 'warning', 'Chemin personnalisé ou différent', 'Vérifiez le dossier réellement utilisé par votre installation (Steam, autre boutique ou option -savedir).');
  if (path.basename(w.folder).toLowerCase() === w.fileStem.toLowerCase() || rootNames.some(n => /^_main\.\d+\.fwl2$/.test(n))) add('nested', 'warning', 'Dossier du monde sélectionné à la place du parent', 'En rejoignant un partage, sélectionner worlds_local, pas le dossier du monde. SaveShare ajoute lui-même le nom du monde : risque de monde imbriqué deux fois.');
  if (rootNames.includes('worlds_local')) add('parent', 'warning', 'Dossier sélectionné trop haut', 'Un sous-dossier worlds_local existe dans le dossier choisi. Vérifiez si celui-ci est la vraie destination.');
  try {
    const nested = await fs.lstat(path.join(w.folder, w.fileStem, w.fileStem));
    if (nested.isDirectory()) add('double-world', 'warning', 'Deux dossiers du monde imbriqués', 'Un dossier portant le nom du monde existe déjà à l’intérieur de sa destination. Vérifiez l’arborescence avant tout déplacement.');
  } catch {}
  if (/\/userdata\/[^/]+\/892970\/remote(?:\/|$)/.test(configured)) add('cloud', 'warning', 'Chemin ressemblant à Steam Cloud', 'Choisissez une sauvegarde locale et évitez deux synchronisations concurrentes. Aucun réglage Steam n’a été lu ou modifié.');
  try { await fs.access(client.journal(w)); add('journal', 'error', 'Restauration interrompue en attente', 'Le diagnostic ne la répare pas. Fermez Valheim puis laissez SaveShare effectuer sa récupération habituelle.'); }
  catch (e) { if (e.code !== 'ENOENT') add('journal', 'warning', 'Journal non vérifié', 'Impossible de vérifier si une récupération est en attente.'); }
  let actual, snapshot;
  try {
    if (!rootSafe) throw Error('Unsafe folder');
    snapshot = await inventory(w);
    actual = [];
    for (const f of snapshot.entries.filter(f => !f.directory)) actual.push({ name: f.name, size: f.size, hash: await fingerprint(path.join(w.folder, f.name), f.size) });
    if (!unchanged(snapshot, await inventory(w))) throw Error('Snapshot changed');
    result.localFiles = actual.length;
    const format = snapshot.format;
    if (!remote?.latest) result.versions.format = format;
    if ((remote?.latest?.format || format) === 'legacy') result.paths.destination = `${path.join(w.folder, w.fileStem)}.db + .fwl`;
    if (!actual.length) add('files', 'warning', 'Aucun fichier du monde à la destination', 'Le monde peut être absent, encore dans le cache, ou enregistré dans un autre dossier.');
    else {
      try { manifest(actual.map(f => ({ ...f, hash: f.hash || '0'.repeat(64) })), w.fileStem, format); add('files', 'ok', 'Structure reconnue par SaveShare', `${actual.length} fichiers. Ce contrôle ne valide pas le contenu binaire ni le chargement dans Valheim.`); }
      catch { add('files', 'warning', 'Structure locale incomplète ou inattendue', 'La paire .db/.fwl ou la génération principale .fwl2/.db2/.chunks/.ok est incomplète, ou un chemin est incompatible.'); }
    }
    if (w.files) {
      const base = compare(actual, w.files);
      const dirty = base.changed.length || base.extra.length || base.missing.length;
      add('dirty', dirty ? 'warning' : base.unverified ? 'warning' : 'ok', dirty ? 'Différences avec la dernière version locale enregistrée' : base.unverified ? 'Progression locale partiellement vérifiée' : 'Aucune modification locale détectée', dirty ? 'Fichiers ajoutés, supprimés ou modifiés. Une récupération manuelle doit conserver une copie de secours.' : base.unverified ? 'Certains fichiers n’ont pas été hachés : aucune conclusion complète sur les modifications locales.' : 'Les empreintes correspondent à la version de référence locale.');
    } else if (actual.length) add('dirty', 'warning', 'Fichiers locaux non associés à une version', 'Ne pas les écraser sans vérifier leur origine et conserver une copie.');
    if (remote?.latest) {
      const comparison = compare(actual, remote.latest.files);
      result.comparison = { ...comparison, missing: comparison.missing.slice(0, 30), changed: comparison.changed.slice(0, 30), extra: comparison.extra.slice(0, 30), missingCount: comparison.missing.length, changedCount: comparison.changed.length, extraCount: comparison.extra.length };
      add('installed', comparison.identical ? 'ok' : 'warning', comparison.identical ? 'Dernière sauvegarde présente à la destination' : 'Dernière sauvegarde non confirmée à la destination', comparison.identical ? 'Tous les fichiers correspondent au serveur. Cela ne confirme pas que Valheim lit ce dossier.' : `${comparison.missing.length} manquants, ${comparison.changed.length} différents, ${comparison.extra.length} supplémentaires, ${comparison.unverified} empreintes non vérifiées.`);
    }
  } catch (e) { actual = undefined; add('files', 'warning', 'Fichiers locaux non vérifiables', `Sauvegarde en cours de modification, lien symbolique, limite dépassée ou ${readableError(e)}. Aucune conclusion sur son intégrité.`); }
  if (remote?.latest) {
    const blobs = [...new Map(remote.latest.files.map(f => [f.hash, f])).values()];
    let valid = 0, missing = 0, invalid = 0, unverified = 0;
    const cacheRoot = await fs.lstat(path.join(client.dir, 'cache')).catch(() => null);
    for (const f of blobs) {
      const filename = path.join(client.dir, 'cache', f.hash);
      try {
        if (cacheRoot && (!cacheRoot.isDirectory() || cacheRoot.isSymbolicLink())) { unverified++; continue; }
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== f.size) { invalid++; continue; }
        const digest = await fingerprint(filename, f.size);
        if (!digest) unverified++; else if (digest === f.hash) valid++; else invalid++;
      } catch (e) { if (e.code === 'ENOENT') missing++; else unverified++; }
    }
    result.cache = { blobs: blobs.length, valid, missing, invalid, unverified };
    add('cache', valid === blobs.length ? 'ok' : 'warning', valid === blobs.length ? 'Dernière sauvegarde entièrement téléchargée' : 'Cache absent, partiel ou non vérifié', `${valid}/${blobs.length} contenus vérifiés ; ${missing} absents, ${invalid} invalides, ${unverified} non vérifiés. Un cache absent n’implique pas que le monde installé est absent.`);
  }
  result.hashedBytes = hashedBytes;
  if (budget <= 0 || Date.now() >= deadline || result.comparison?.unverified || result.cache?.unverified) add('limits', 'warning', 'Vérification des empreintes limitée', 'Budget maximal de 512 Mio et environ 30 secondes de lecture. Les fichiers non vérifiés ne sont pas déclarés conformes.');
  add('visibility', 'info', 'Visibilité dans Valheim non vérifiable automatiquement', 'Comparez les versions de Valheim et la boutique utilisée. Une copie identique peut rester invisible si le jeu lit ailleurs ou refuse son format. Le nom du partage SaveShare peut différer du nom affiché en jeu.');
  const destination = result.versions.format === 'legacy' ? `${sharedPath(path.join(w.folder, `${w.fileStem}.db`), w.fileStem)} + .fwl` : sharedPath(result.paths.destination, w.fileStem);
  const lines = ['SaveShare — Diagnostic en lecture seule', `Application : ${version}`, `Système : ${platform}`, `Date : ${result.generatedAt}`, `Monde (identifiant) : ${isId(w.id) ? w.id : 'masqué'}`, `Dossier configuré : ${sharedPath(w.folder, w.fileStem)}`, `Destination : ${destination}`, `Chemin habituel : ${sharedPath(result.paths.usual, w.fileStem)}`, `Version locale enregistrée : ${result.versions.local}`, `Version serveur : ${result.versions.remote}`, `Format : ${result.versions.format}`, ''];
  for (const check of checks) lines.push(`[${check.level.toUpperCase()}] ${check.title} — ${check.detail}`);
  if (result.comparison) for (const [key, label] of [['missing', 'Manquants'], ['changed', 'Différents'], ['extra', 'Supplémentaires']]) {
    if (result.comparison[key].length) lines.push(`${label} (30 premiers maximum) : ${result.comparison[key].map(name => sharedFilename(name, w.fileStem)).join(', ')}`);
  }
  lines.push('', 'Aucun fichier créé, déplacé, téléchargé, restauré ou supprimé par ce diagnostic.', 'Clés, invitations, serveur, pseudos, noms de mondes et préfixes de chemins exclus du rapport.');
  result.report = lines.join('\n');
  return result;
}
module.exports = { diagnose, compare, usualFolder, sharedPath };
