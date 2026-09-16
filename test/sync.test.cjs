const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/index.cjs');
const { Client, serverURL } = require('../desktop/client.cjs');
const { hash, id, atomicJSON } = require('../shared/common.cjs');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saveshare-test-'));
  const admin = 'test-only-admin-key-with-at-least-32-characters';
  const server = createServer({ dataDir: path.join(root, 'server'), adminToken: admin, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const folderA = path.join(root, 'game-a'), folderB = path.join(root, 'game-b');
  await fs.mkdir(folderA); await fs.mkdir(folderB);
  await fs.writeFile(path.join(folderA, 'Midgard.db'), 'day one world');
  await fs.writeFile(path.join(folderA, 'Midgard.fwl'), 'seed 42');
  await fs.writeFile(path.join(folderA, 'AnotherWorld.db'), 'untouched');
  const a = await new Client({ dataDir: path.join(root, 'a') }).init();
  const b = await new Client({ dataDir: path.join(root, 'b') }).init();
  const wid = await a.add({ server: url, adminToken: admin, name: 'Les Vikings', fileStem: 'Midgard', folder: folderA, author: 'Alice' });
  await b.add({ invite: a.invitation(wid), folder: folderB, author: 'Bob' });
  return { root, server, url, admin, folderA, folderB, a, b, wid };
}
test('two players: publish, lock, automatic receive, handoff and restore with full history', async t => {
  const { a, b, wid, folderA, folderB } = await fixture(t);
  await a.start(wid);
  await assert.rejects(b.start(wid), /Session expirée|détenue/);
  b.stateFor(b.get(wid)).autoApply = true;
  await b.tick();
  assert.equal(await fs.readFile(path.join(folderB, 'Midgard.db'), 'utf8'), 'day one world');
  await fs.writeFile(path.join(folderA, 'Midgard.db'), 'day two world');
  await a.finish(wid); await b.tick();
  assert.equal(await fs.readFile(path.join(folderB, 'Midgard.db'), 'utf8'), 'day two world');
  const original = b.stateFor(b.get(wid)).remote.versions.at(-1).id;
  await b.start(wid); await fs.writeFile(path.join(folderB, 'Midgard.db'), 'Bob built a castle'); await b.finish(wid);
  await a.pull(wid); assert.equal(await fs.readFile(path.join(folderA, 'Midgard.db'), 'utf8'), 'Bob built a castle');
  await a.restore(wid, original);
  assert.equal(await fs.readFile(path.join(folderA, 'Midgard.db'), 'utf8'), 'day one world');
  assert.equal(await fs.readFile(path.join(folderA, 'AnotherWorld.db'), 'utf8'), 'untouched');
  const versions = (await a.info(a.get(wid))).versions;
  assert.equal(versions.length, 4); assert.equal(versions[0].parent, versions[1].id);
  assert.match(versions[0].message, /Restauration/);
  assert.equal(await fs.readFile(path.join(a.get(wid).backup, 'Midgard.db'), 'utf8'), 'Bob built a castle');
});
test('dirty local files are never auto-replaced; explicit pull keeps a backup', async t => {
  const { a, b, wid, folderA, folderB } = await fixture(t);
  await a.start(wid); await a.finish(wid); await b.pull(wid);
  await fs.writeFile(path.join(folderB, 'Midgard.db'), 'offline Bob');
  await a.start(wid); await fs.writeFile(path.join(folderA, 'Midgard.db'), 'online Alice'); await a.finish(wid);
  b.stateFor(b.get(wid)).autoApply = true; await b.tick();
  assert.match(b.stateFor(b.get(wid)).error, /Progression locale différente/);
  assert.equal(await fs.readFile(path.join(folderB, 'Midgard.db'), 'utf8'), 'offline Bob');
  await b.pull(wid, true);
  assert.equal(await fs.readFile(path.join(b.get(wid).backup, 'Midgard.db'), 'utf8'), 'offline Bob');
});
test('stale parent, malformed manifest, bad blob digest, and authentication are rejected', async t => {
  const { a, wid, url } = await fixture(t); await a.start(wid);
  const w = a.get(wid), session = a.stateFor(w).session;
  const body = { parent: null, files: w.files, clientId: a.config.clientId, leaseToken: session.token };
  await assert.rejects(a.api(w, '/commits', 'POST', body), /monde a avancé/);
  await assert.rejects(a.api(w, '/commits', 'POST', { ...body, parent: w.base, files: [{ name: '../escape', hash: hash('bad'), size: 3 }, w.files[1]] }), /Manifeste/);
  const { Readable } = require('node:stream');
  await assert.rejects(a.api(w, `/blobs/${hash('expected')}`, 'PUT', Readable.from(['wrong']), { 'x-client-id': a.config.clientId, 'x-lease-token': session.token }), /Empreinte/);
  const response = await fetch(`${url}/worlds/${wid}`, { headers: { Authorization: 'Bearer wrong' } }); assert.equal(response.status, 401);
  await assert.rejects(a.api(w, '/commits', 'POST', { ...body, parent: w.base, files: [{ ...w.files[0], hash: hash('missing') }, w.files[1]] }), /incomplète/);
});
test('lease expiry and server restart preserve exclusive ownership', async t => {
  const { a, b, wid, root, server, admin } = await fixture(t, { leaseMs: 2000 });
  await a.start(wid);
  const token = a.stateFor(a.get(wid)).session.token;
  await new Promise(resolve => setTimeout(resolve, 2100));
  await b.start(wid);
  await fs.writeFile(path.join(a.get(wid).folder, 'Midgard.db'), 'late write');
  await assert.rejects(a.publish(wid), /Session expirée|détenue/);
  const persisted = JSON.parse(await fs.readFile(path.join(root, 'server', wid, 'world.json'), 'utf8'));
  assert.equal(persisted.lease.clientId, b.config.clientId);
  assert.notEqual(persisted.lease.token, token);
  await a.renew(); assert.equal(a.stateFor(a.get(wid)).session, null);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const second = createServer({ dataDir: path.join(root, 'server'), adminToken: admin });
  await new Promise(resolve => second.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${second.address().port}/worlds/${wid}`, { headers: { Authorization: `Bearer ${a.get(wid).key}` } });
    const world = await response.json(); assert.equal(world.head, persisted.head);
  } finally { second.closeAllConnections(); await new Promise(resolve => second.close(resolve)); }
});
test('game running blocks replacements; restart disables automatic apply', async t => {
  const { a, b, wid, root } = await fixture(t); await a.start(wid); await a.finish(wid);
  b.isGameRunning = async () => true;
  await assert.rejects(b.pull(wid, true), /Fermez Valheim/);
  await assert.rejects(b.start(wid), /Fermez Valheim/);
  b.stateFor(b.get(wid)).autoApply = true;
  const restarted = await new Client({ dataDir: path.join(root, 'b') }).init();
  assert.equal(restarted.stateFor(restarted.get(wid)).autoApply, false);
});
test('interrupted two-file apply rolls back both files from journal', async t => {
  const { a, wid, root, folderA } = await fixture(t); await a.start(wid); await a.finish(wid);
  const w = a.get(wid), backup = path.join(root, 'recovery'); await fs.mkdir(backup);
  for (const ext of ['db', 'fwl']) await fs.copyFile(path.join(folderA, `Midgard.${ext}`), path.join(backup, `Midgard.${ext}`));
  await atomicJSON(a.journal(w), { backup, existing: ['Midgard.db', 'Midgard.fwl'], base: w.base, files: w.files });
  await fs.writeFile(path.join(folderA, 'Midgard.db'), 'half applied');
  const restarted = await new Client({ dataDir: path.join(root, 'a') }).init();
  assert.equal(await fs.readFile(path.join(folderA, 'Midgard.db'), 'utf8'), 'day one world');
  assert.equal(restarted.get(wid).base, w.base);
  await assert.rejects(fs.stat(a.journal(w)), { code: 'ENOENT' });
});
test('network URLs require HTTPS', () => {
  assert.throws(() => serverURL('http://example.com'), /HTTPS/);
  assert.throws(() => serverURL('https://user:secret@example.com'), /origine/);
  assert.equal(serverURL('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});
test('symlinks are refused', async t => {
  const { a, wid, folderA, root } = await fixture(t);
  const external = path.join(root, 'external'); await fs.writeFile(external, 'private');
  await fs.unlink(path.join(folderA, 'Midgard.db'));
  try { await fs.symlink(external, path.join(folderA, 'Midgard.db')); }
  catch (e) { if (e.code === 'EPERM' && process.platform === 'win32') { t.skip('Windows runner does not allow symlinks'); return; } throw e; }
  await assert.rejects(a.scan(a.get(wid)), /liens symboliques/);
});
test('automatic publication waits for quiet files and later transfers changes', async t => {
  const { a, b, wid, folderA, folderB } = await fixture(t);
  await a.start(wid); await b.pull(wid);
  b.stateFor(b.get(wid)).autoApply = true;
  await fs.writeFile(path.join(folderA, 'Midgard.db'), 'new building');
  await a.tick(); assert.match(a.stateFor(a.get(wid)).error, /écrit encore/);
  const past = new Date(Date.now() - 20_000);
  for (const ext of ['db', 'fwl']) await fs.utimes(path.join(folderA, `Midgard.${ext}`), past, past);
  await a.tick(); await b.tick();
  assert.equal(await fs.readFile(path.join(folderB, 'Midgard.db'), 'utf8'), 'new building');
});
test('two simultaneous lease requests grant ownership to exactly one client', async t => {
  const { a, b, wid } = await fixture(t); const w = a.get(wid);
  const results = await Promise.allSettled([a.api(w, '/lease', 'PUT', { clientId: a.config.clientId }), b.api(b.get(wid), '/lease', 'PUT', { clientId: b.config.clientId })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});
test('late renewal cannot resurrect a released session', async t => {
  const { a, wid } = await fixture(t); await a.start(wid);
  const w = a.get(wid), leaseToken = a.stateFor(w).session.token;
  await a.finish(wid);
  await assert.rejects(a.api(w, '/lease', 'PUT', { clientId: a.config.clientId, leaseToken }), /Session expirée/);
  assert.equal((await a.info(w)).lease, null);
});
