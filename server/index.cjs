const http = require('node:http');
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { hash, id, fail, isHash, isId, worldName, manifest, atomicJSON, readJSON } = require('../shared/common.cjs');

const LEASE_MS = 90_000;
const MAX_BLOB = 1024 ** 3;
function equalSecret(a, b) { return crypto.timingSafeEqual(Buffer.from(hash(a || '')), Buffer.from(hash(b || ''))); }
async function jsonBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) fail('Requête trop volumineuse.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('JSON invalide.'); }
}
function createServer({ dataDir, adminToken, leaseMs = LEASE_MS }) {
  if (!adminToken || adminToken.length < 32) throw new Error('SAVESHARE_ADMIN_TOKEN doit contenir au moins 32 caractères.');
  const queues = new Map();
  const worldFile = wid => path.join(dataDir, wid, 'world.json');
  const blobFile = (wid, digest) => path.join(dataDir, wid, 'blobs', digest);
  function serial(key, fn) {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn); queues.set(key, next);
    return next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  }
  function checkLease(world, body) {
    if (!world.lease || world.lease.expires <= Date.now() || world.lease.clientId !== body.clientId || !equalSecret(world.lease.token, body.leaseToken)) fail('Session expirée ou détenue par un autre joueur. Votre progression locale est conservée.', 409);
  }
  function publicWorld(w) {
    return { id: w.id, name: w.name, fileStem: w.fileStem, head: w.head, versions: w.versions,
      lease: w.lease && w.lease.expires > Date.now() ? { clientId: w.lease.clientId, author: w.lease.author, expires: w.lease.expires } : null };
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, protocol: 1 });
      const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '';
      if (req.method === 'POST' && url.pathname === '/worlds') {
        if (!equalSecret(token, adminToken)) fail('Clé administrateur incorrecte.', 401);
        const body = await jsonBody(req); const stem = worldName(body.fileStem);
        const key = crypto.randomBytes(32).toString('base64url');
        const w = { id: id(), name: String(body.name || stem).slice(0, 80), fileStem: stem, keyHash: hash(key), head: null, versions: [], lease: null };
        await atomicJSON(worldFile(w.id), w); return send(201, { ...publicWorld(w), key });
      }
      const match = /^\/worlds\/([a-f0-9-]{36})(?:\/(lease|commits|blobs)(?:\/([a-f0-9]{64}))?)?$/.exec(url.pathname);
      if (!match || !isId(match[1])) fail('Route inconnue.', 404);
      const [, wid, action, digest] = match;
      let w; try { w = await readJSON(worldFile(wid)); } catch (e) { if (e.code === 'ENOENT') fail('Monde introuvable.', 404); throw e; }
      if (!equalSecret(hash(token), w.keyHash)) fail('Invitation incorrecte.', 401);
      if (req.method === 'GET' && !action) return send(200, publicWorld(w));
      if (action === 'blobs' && isHash(digest)) {
        if (req.method === 'GET') {
          // Only published data may be downloaded.
          if (!w.versions.some(v => v.files.some(f => f.hash === digest))) fail('Fichier non publié.', 404);
          const stat = await fs.stat(blobFile(wid, digest));
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
          await pipeline(createReadStream(blobFile(wid, digest)), res); return;
        }
        if (req.method === 'PUT') {
          checkLease(w, { clientId: req.headers['x-client-id'], leaseToken: req.headers['x-lease-token'] });
          await fs.mkdir(path.dirname(blobFile(wid, digest)), { recursive: true });
          const temp = `${blobFile(wid, digest)}.${id()}.tmp`;
          let size = 0; const checksum = crypto.createHash('sha256');
          try {
            await pipeline(req, new Transform({ transform(chunk, enc, cb) { size += chunk.length; if (size > MAX_BLOB) return cb(Object.assign(new Error('Fichier trop volumineux (1 Gio maximum).'), { status: 413 })); checksum.update(chunk); cb(null, chunk); } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
            if (checksum.digest('hex') !== digest) fail('Empreinte SHA-256 incorrecte.');
            await fs.rename(temp, blobFile(wid, digest));
          } finally { await fs.rm(temp, { force: true }); }
          return send(200, { ok: true, size });
        }
      }
      const body = await jsonBody(req);
      return await serial(wid, async () => {
        w = await readJSON(worldFile(wid));
        if (action === 'lease' && req.method === 'PUT') {
          if (!isId(body.clientId)) fail('Identifiant client invalide.');
          if (body.leaseToken || (w.lease && w.lease.expires > Date.now())) checkLease(w, body);
          w.lease = { clientId: body.clientId, author: String(body.author || 'Viking').slice(0, 60), token: w.lease?.expires > Date.now() ? w.lease.token : crypto.randomBytes(32).toString('base64url'), expires: Date.now() + leaseMs };
          await atomicJSON(worldFile(wid), w); return send(200, w.lease);
        }
        if (action === 'lease' && req.method === 'DELETE') {
          checkLease(w, body); w.lease = null; await atomicJSON(worldFile(wid), w); return send(200, { ok: true });
        }
        if (action === 'commits' && req.method === 'POST') {
          checkLease(w, body);
          if (body.parent !== w.head) fail('Le monde a avancé depuis votre dernière synchronisation. Progression locale conservée ; récupérez la nouvelle version avant de reprendre.', 409);
          const files = manifest(body.files, w.fileStem);
          for (const f of files) {
            const stat = await fs.stat(blobFile(wid, f.hash)).catch(() => null);
            if (!stat || stat.size !== f.size) fail('Sauvegarde incomplète : un fichier manque sur le serveur.');
          }
          const commit = { id: id(), parent: w.head, createdAt: new Date().toISOString(), author: w.lease.author, message: String(body.message || 'Sauvegarde automatique').slice(0, 200), files };
          w.head = commit.id; w.versions.unshift(commit); await atomicJSON(worldFile(wid), w);
          return send(201, commit);
        }
        fail('Route inconnue.', 404);
      });
    } catch (e) {
      if (res.headersSent || res.destroyed) return res.destroy();
      if (!e.status) console.error('SaveShare:', e.message);
      send(e.status || 500, { error: e.status ? e.message : 'Erreur du serveur. Consultez ses journaux.' });
    }
  });
  server.requestTimeout = 10 * 60_000;
  return server;
}
if (require.main === module) {
  const server = createServer({ dataDir: path.resolve(process.env.SAVESHARE_DATA || './data'), adminToken: process.env.SAVESHARE_ADMIN_TOKEN });
  server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => console.log(`SaveShare écoute sur ${JSON.stringify(server.address())}`));
}
module.exports = { createServer };
