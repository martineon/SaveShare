const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { hash, id, fail, isId, worldName, manifest, atomicJSON, readJSON, sameFiles } = require('../shared/common.cjs');

function serverURL(raw) {
  let url; try { url = new URL(raw); } catch { fail('Adresse du serveur invalide.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('Indiquez seulement l’origine du serveur, par exemple https://saves.example.fr.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('HTTPS est obligatoire, sauf pour un serveur sur cet ordinateur.');
  return url.origin;
}
async function fileHash(filename) {
  const sha = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) sha.update(chunk);
  return sha.digest('hex');
}
async function plainFile(filename) {
  const stat = await fs.lstat(filename).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail('Les liens symboliques et les dossiers ne sont pas acceptés comme sauvegardes.');
  return stat;
}
class Client {
  constructor({ dataDir, isGameRunning = async () => false, onChange = () => {} }) {
    this.dir = dataDir; this.isGameRunning = isGameRunning; this.onChange = onChange;
    this.runtime = new Map(); this.busy = false; this.renewing = false;
  }
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    this.config = await readJSON(path.join(this.dir, 'config.json')).catch(e => { if (e.code === 'ENOENT') return { clientId: id(), author: os.userInfo().username, worlds: [] }; throw e; });
    // No automatic filesystem replacement is enabled after a restart.
    for (const w of this.config.worlds) await this.recover(w);
    return this;
  }
  stateFor(w) {
    if (!this.runtime.has(w.id)) this.runtime.set(w.id, { autoApply: false, session: null, remote: null, error: null, status: 'En attente' });
    return this.runtime.get(w.id);
  }
  async save() { await atomicJSON(path.join(this.dir, 'config.json'), this.config); }
  state() {
    return { author: this.config.author, busy: this.busy, worlds: this.config.worlds.map(w => {
      const r = this.stateFor(w); return { id: w.id, name: w.name, fileStem: w.fileStem, server: w.server, folder: w.folder, base: w.base, autoApply: r.autoApply, active: !!r.session, status: r.status, error: r.error, remote: r.remote, backup: w.backup || null };
    }) };
  }
  async exclusive(fn) {
    if (this.busy) fail('Une opération est déjà en cours. Réessayez dans un instant.');
    this.busy = true; this.onChange();
    try { return await fn(); } finally { this.busy = false; this.onChange(); }
  }
  get(wid) { return this.config.worlds.find(w => w.id === wid) || fail('Monde non configuré.'); }
  async api(w, route = '', method = 'GET', body, headers = {}) {
    const res = await fetch(`${w.server}/worlds${w.id ? '/' + w.id : ''}${route}`, {
      method, headers: { Authorization: `Bearer ${w.key}`, ...(body && typeof body.pipe !== 'function' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body.pipe === 'function' ? body : JSON.stringify(body),
      ...(body && typeof body.pipe === 'function' ? { duplex: 'half' } : {}),
      signal: AbortSignal.timeout(10 * 60_000), redirect: 'error'
    });
    if (!res.ok) { const msg = await res.json().catch(() => ({ error: `Erreur HTTP ${res.status}` })); fail(msg.error, res.status); }
    return res;
  }
  async info(w) {
    const remote = await (await this.api(w)).json();
    if (remote.id !== w.id || remote.fileStem !== w.fileStem || !Array.isArray(remote.versions)) fail('Réponse du serveur invalide.');
    for (const v of remote.versions) { if (!isId(v.id)) fail('Version invalide.'); v.files = manifest(v.files, w.fileStem); }
    if (remote.head && remote.versions[0]?.id !== remote.head) fail('Historique du serveur incohérent.');
    this.stateFor(w).remote = remote; return remote;
  }
  async folder(raw) {
    const folder = await fs.realpath(raw);
    if (!(await fs.stat(folder)).isDirectory()) fail('Choisissez un dossier de sauvegardes.');
    return folder;
  }
  async add({ server, adminToken, name, fileStem, folder, invite, author }) {
    if (typeof author === 'string' && author.trim()) this.config.author = author.trim().slice(0, 60);
    folder = await this.folder(folder);
    let w;
    if (invite) {
      let data; try { data = JSON.parse(Buffer.from(invite.trim().replace(/^saveshare:/, ''), 'base64url').toString()); } catch { fail('Code d’invitation invalide.'); }
      if (!isId(data.id) || typeof data.key !== 'string' || data.key.length < 32) fail('Code d’invitation invalide.');
      const target = { server: serverURL(data.server), id: data.id, key: data.key };
      const remote = await (await this.api(target)).json();
      w = { ...target, name: remote.name, fileStem: worldName(remote.fileStem), folder, base: null, files: null };
    } else {
      worldName(fileStem);
      if (this.config.worlds.some(x => x.folder.toLowerCase() === folder.toLowerCase() && x.fileStem.toLowerCase() === fileStem.toLowerCase())) fail('Cette paire de fichiers est déjà configurée.');
      const candidate = { folder, fileStem };
      await this.scan(candidate); // Verify both files before creating the remote world.
      const remote = await (await this.api({ server: serverURL(server), key: adminToken }, '', 'POST', { name, fileStem })).json();
      w = { server: serverURL(server), id: remote.id, key: remote.key, name: remote.name, fileStem, folder, base: null, files: null };
    }
    if (this.config.worlds.some(x => x.id === w.id || (x.folder.toLowerCase() === folder.toLowerCase() && x.fileStem.toLowerCase() === w.fileStem.toLowerCase()))) fail('Ce monde ou cette paire de fichiers est déjà configuré.');
    this.config.worlds.push(w); await this.save(); await this.info(w); return w.id;
  }
  invitation(wid) { const w = this.get(wid); return 'saveshare:' + Buffer.from(JSON.stringify({ server: w.server, id: w.id, key: w.key })).toString('base64url'); }
  async scan(w, { allowMissing = false, capture = false, quiet = false } = {}) {
    const files = [], before = [];
    for (const name of [`${w.fileStem}.db`, `${w.fileStem}.fwl`]) {
      const filename = path.join(w.folder, name), stat = await plainFile(filename);
      if (!stat) { if (allowMissing) continue; fail(`Fichier manquant : ${name}. Utilisez une sauvegarde locale Valheim avec sa paire .db / .fwl.`); }
      if (stat.size < 1 || stat.size > 1024 ** 3) fail(`${name} est vide ou dépasse la limite de 1 Gio.`);
      if (quiet && Date.now() - stat.mtimeMs < 10_000) fail('Valheim écrit encore sa sauvegarde. Nouvelle tentative au prochain passage.');
      before.push({ filename, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
      if (capture) {
        await fs.mkdir(path.join(this.dir, 'cache'), { recursive: true });
        const temp = path.join(this.dir, 'cache', `${id()}.tmp`);
        try {
          await fs.copyFile(filename, temp); const digest = await fileHash(temp);
          await fs.rename(temp, path.join(this.dir, 'cache', digest));
          files.push({ name, size: stat.size, hash: digest });
        } finally { await fs.rm(temp, { force: true }); }
      } else files.push({ name, size: stat.size, hash: await fileHash(filename) });
    }
    for (const b of before) { const after = await plainFile(b.filename); if (!after || after.size !== b.size || after.mtimeMs !== b.mtimeMs || after.ctimeMs !== b.ctimeMs) fail('Sauvegarde modifiée pendant la lecture. Réessayez après la sauvegarde du jeu.'); }
    return files;
  }
  async cache(w, version) {
    if (!version) return;
    await fs.mkdir(path.join(this.dir, 'cache'), { recursive: true });
    for (const f of version.files) {
      const target = path.join(this.dir, 'cache', f.hash);
      if (await plainFile(target) && await fileHash(target) === f.hash) continue;
      const res = await this.api(w, `/blobs/${f.hash}`); const temp = `${target}.${id()}.tmp`; let size = 0;
      try {
        await pipeline(Readable.fromWeb(res.body), new Transform({ transform(chunk, enc, cb) { size += chunk.length; cb(size > f.size ? new Error('Téléchargement trop volumineux.') : null, chunk); } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
        if (size !== f.size || await fileHash(temp) !== f.hash) fail('Sauvegarde téléchargée corrompue. Aucun fichier du jeu n’a été remplacé.');
        await fs.rename(temp, target);
      } finally { await fs.rm(temp, { force: true }); }
    }
  }
  journal(w) { return path.join(this.dir, `transaction-${w.id}.json`); }
  async recover(w) {
    const j = await readJSON(this.journal(w)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!j) return;
    if (await this.isGameRunning()) fail('Une restauration interrompue doit être récupérée. Fermez Valheim puis redémarrez SaveShare.');
    for (const name of [`${w.fileStem}.db`, `${w.fileStem}.fwl`]) {
      const dest = path.join(w.folder, name); await plainFile(dest);
      if (j.existing.includes(name)) {
        const temp = path.join(w.folder, `.saveshare-${id()}.tmp`);
        await fs.copyFile(path.join(j.backup, name), temp); await fs.rename(temp, dest);
      } else await fs.rm(dest, { force: true });
    }
    w.base = j.base; w.files = j.files; w.backup = j.backup; await this.save();
    await fs.rm(this.journal(w));
  }
  async apply(w, version, force = false) {
    if (await this.isGameRunning()) fail('Fermez Valheim et son serveur dédié avant de remplacer les fichiers.');
    await this.recover(w);
    const before = await this.scan(w, { allowMissing: true });
    if (!force && before.length && !sameFiles(before, w.files)) fail('Progression locale différente. Utilisez « Récupérer » pour la sauvegarder à part et appliquer la version partagée.', 409);
    await this.cache(w, version);
    const backup = path.join(this.dir, 'backups', `${Date.now()}-${id()}`);
    await fs.mkdir(backup, { recursive: true });
    for (const f of before) await fs.copyFile(path.join(w.folder, f.name), path.join(backup, f.name));
    if (!sameFiles(before, await this.scan(w, { allowMissing: true })) || await this.isGameRunning()) fail('Les fichiers ou le jeu ont changé pendant la préparation. Réessayez jeu fermé.');
    await atomicJSON(this.journal(w), { backup, existing: before.map(f => f.name), base: w.base, files: w.files });
    try {
      for (const f of version.files) {
        const temp = path.join(w.folder, `.saveshare-${id()}.tmp`);
        try { await fs.copyFile(path.join(this.dir, 'cache', f.hash), temp); await plainFile(path.join(w.folder, f.name)); await fs.rename(temp, path.join(w.folder, f.name)); }
        finally { await fs.rm(temp, { force: true }); }
      }
      w.base = version.id; w.files = version.files; w.backup = backup; await this.save();
      await fs.rm(this.journal(w));
    } catch (e) { await this.recover(w); throw e; }
  }
  async start(wid) {
    const w = this.get(wid), r = this.stateFor(w);
    if (r.session) return;
    if (await this.isGameRunning()) fail('Fermez Valheim avant de prendre la session et récupérer le monde à jour.');
    r.autoApply = false;
    const lease = await (await this.api(w, '/lease', 'PUT', { clientId: this.config.clientId, author: this.config.author })).json();
    r.session = lease;
    try {
      const remote = await this.info(w);
      if (remote.head && remote.head !== w.base) await this.apply(w, remote.versions[0]);
      if (!remote.head) await this.publish(wid, 'Première sauvegarde');
      r.error = null; r.status = 'Votre session · lancez Valheim';
    } catch (e) { await this.release(w).catch(() => {}); r.session = null; throw e; }
  }
  async release(w) {
    const r = this.stateFor(w);
    await this.api(w, '/lease', 'DELETE', { clientId: this.config.clientId, leaseToken: r.session?.token });
    r.session = null;
    if (r.remote) r.remote.lease = null;
  }
  async publish(wid, message = 'Sauvegarde automatique', quiet = false) {
    const w = this.get(wid), r = this.stateFor(w);
    if (!r.session) fail('Prenez la session avant de publier.');
    if (sameFiles(await this.scan(w, { quiet }), w.files)) return;
    const files = await this.scan(w, { capture: true, quiet });
    const leaseToken = r.session.token;
    for (const f of files) await this.api(w, `/blobs/${f.hash}`, 'PUT', createReadStream(path.join(this.dir, 'cache', f.hash)), { 'x-client-id': this.config.clientId, 'x-lease-token': leaseToken });
    const commit = await (await this.api(w, '/commits', 'POST', { clientId: this.config.clientId, leaseToken, parent: w.base, files, message })).json();
    w.base = commit.id; w.files = files; await this.save(); await this.info(w); r.error = null; r.status = 'Sauvegarde partagée';
  }
  async finish(wid) {
    if (await this.isGameRunning()) fail('Sauvegardez et fermez Valheim avant de terminer votre session.');
    await this.publish(wid, 'Fin de session');
    const w = this.get(wid); await this.release(w); this.stateFor(w).status = 'Session terminée';
  }
  async pull(wid, force = false) {
    const w = this.get(wid), r = this.stateFor(w);
    if (r.session) fail('Terminez votre session avant de récupérer une version.');
    const remote = await this.info(w);
    if (!remote.head) fail('Ce monde n’a pas encore de sauvegarde partagée.');
    await this.apply(w, remote.versions[0], force); r.error = null; r.status = 'À jour sur cet ordinateur';
  }
  async restore(wid, versionId) {
    const w = this.get(wid), r = this.stateFor(w);
    if (await this.isGameRunning()) fail('Fermez Valheim avant de restaurer une version.');
    if (r.session) fail('Terminez votre session avant de restaurer une version.');
    await this.start(wid);
    try {
      const remote = await this.info(w), version = remote.versions.find(v => v.id === versionId);
      if (!version) fail('Version introuvable.');
      await this.cache(w, version);
      const commit = await (await this.api(w, '/commits', 'POST', { clientId: this.config.clientId, leaseToken: r.session.token, parent: w.base, files: version.files, message: `Restauration de ${versionId.slice(0, 8)}` })).json();
      await this.apply(w, commit, true); await this.info(w); r.status = 'Version restaurée et partagée';
    } finally { await this.release(w); }
  }
  async renew() {
    if (this.renewing) return; this.renewing = true;
    try {
      for (const w of this.config.worlds) {
        const r = this.stateFor(w); if (!r.session) continue;
        const original = r.session;
        try {
          const lease = await (await this.api(w, '/lease', 'PUT', { clientId: this.config.clientId, author: this.config.author, leaseToken: original.token })).json();
          if (r.session === original) r.session = lease;
        } catch (e) { r.error = e.message; if (e.status === 409 || original.expires < Date.now()) { r.session = null; r.status = 'Session perdue · progression locale conservée'; } }
      }
    } finally { this.renewing = false; this.onChange(); }
  }
  async tick() {
    if (this.busy) return;
    await this.exclusive(async () => {
      for (const w of this.config.worlds) {
        const r = this.stateFor(w);
        try {
          const remote = await this.info(w);
          if (r.session) { await this.publish(w.id, 'Sauvegarde automatique', true); continue; }
          if (remote.head && remote.head !== w.base) {
            await this.cache(w, remote.versions[0]);
            r.status = 'Nouvelle version téléchargée';
            if (r.autoApply && !(await this.isGameRunning())) { await this.apply(w, remote.versions[0]); r.status = 'À jour sur cet ordinateur'; }
          } else {
            r.status = remote.head ? 'À jour sur cet ordinateur' : 'Prêt pour la première session';
            if (w.files && !sameFiles(await this.scan(w, { allowMissing: true }), w.files)) fail('Des modifications locales ne sont pas encore publiées. Prenez la session pour les partager, ou récupérez la version du groupe.');
          }
          r.error = null;
        } catch (e) { r.error = e.message; }
      }
    });
  }
}
module.exports = { Client, serverURL, fileHash };
