const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('../desktop/client.cjs');
const { createServer } = require('../server/index.cjs');
const { diagnose, compare, sharedPath, usualFolder } = require('../desktop/diagnostics.cjs');

async function fixture(t, folderFormat = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saveshare-diagnostic-'));
  const server = createServer({ dataDir: path.join(root, 'server'), adminToken: 'diagnostic-secret-admin-token-32-characters' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const aFolder = path.join(root, 'a-worlds'), bFolder = path.join(root, 'worlds_local');
  await fs.mkdir(aFolder); await fs.mkdir(bFolder);
  if (folderFormat) {
    const folder = path.join(aFolder, 'PrivateWorld'); await fs.mkdir(folder);
    for (const [name, value] of Object.entries({ '_main.1.db2': 'world', '_main.1.fwl2': 'seed', '_main.1.chunks': 'index', '_main.1.ok': '', '0_0__1_1.chunk': 'chunk' })) await fs.writeFile(path.join(folder, name), value);
  } else {
    await fs.writeFile(path.join(aFolder, 'PrivateWorld.db'), 'world'); await fs.writeFile(path.join(aFolder, 'PrivateWorld.fwl'), 'seed');
  }
  const a = await new Client({ dataDir: path.join(root, 'a') }).init();
  const b = await new Client({ dataDir: path.join(root, 'b') }).init();
  const wid = await a.add({ server: `http://127.0.0.1:${server.address().port}`, adminToken: 'diagnostic-secret-admin-token-32-characters', folder: aFolder, fileStem: 'PrivateWorld', name: 'SecretDisplayName', author: 'PrivateAuthor' });
  await a.start(wid); await a.finish(wid);
  await b.add({ invite: a.invitation(wid), folder: bFolder });
  return { root, a, b, wid, aFolder, bFolder, server };
}
const run = (client, wid, options = {}) => diagnose(client, wid, { version: '0.5.0', ...options });
const check = (report, code) => report.checks.find(c => c.code === code);

test('diagnostic distinguishes downloaded, missing and installed without modifying config, files or server', async t => {
  const { root, a, b, wid, bFolder } = await fixture(t);
  const config = await fs.readFile(path.join(root, 'b', 'config.json'));
  const metadata = await fs.readFile(path.join(root, 'server', wid, 'world.json'));
  const missing = await run(b, wid);
  assert.equal(missing.comparison.missingCount, 5); assert.equal(missing.cache.valid, 0);
  assert.deepEqual(await fs.readdir(bFolder), []);
  const remote = await a.info(a.get(wid)); await b.cache(b.get(wid), remote.versions[0]);
  const downloaded = await run(b, wid);
  assert.equal(downloaded.cache.valid, 5); assert.equal(downloaded.comparison.identical, false);
  assert.deepEqual(await fs.readFile(path.join(root, 'b', 'config.json')), config);
  assert.deepEqual(await fs.readFile(path.join(root, 'server', wid, 'world.json')), metadata);
  assert.deepEqual(await fs.readdir(bFolder), []);
  await b.pull(wid);
  const installed = await run(b, wid);
  assert.equal(installed.comparison.identical, true); assert.equal(check(installed, 'installed').level, 'ok');
  assert.match(check(installed, 'installed').detail, /ne confirme pas que Valheim/);
  const secondConfig = await fs.readFile(path.join(root, 'b', 'config.json'));
  await run(b, wid); assert.deepEqual(await fs.readFile(path.join(root, 'b', 'config.json')), secondConfig);
});

test('wrong join path and nested worlds produce actionable path warnings', async t => {
  const { b, wid, bFolder } = await fixture(t);
  await b.pull(wid);
  b.get(wid).folder = path.join(bFolder, 'PrivateWorld');
  const wrong = await run(b, wid);
  assert.ok(check(wrong, 'nested'));
  assert.equal(wrong.comparison.missingCount, 5);
  assert.equal(wrong.paths.destination, path.join(bFolder, 'PrivateWorld', 'PrivateWorld'));
  assert.match(wrong.report, /worlds_local\/<monde>\/<monde>/);
  b.get(wid).folder = bFolder;
  await fs.mkdir(path.join(bFolder, 'PrivateWorld', 'PrivateWorld'));
  assert.ok(check(await run(b, wid), 'double-world'));
});

test('missing, modified and extra files are reported; game and session blockers remain read only', async t => {
  const { b, wid, bFolder } = await fixture(t); await b.pull(wid);
  await fs.unlink(path.join(bFolder, 'PrivateWorld', '_main.1.ok'));
  await fs.writeFile(path.join(bFolder, 'PrivateWorld', '_main.1.db2'), 'changed');
  await fs.writeFile(path.join(bFolder, 'PrivateWorld', 'unexpected.dat'), 'extra');
  b.isGameRunning = async () => true;
  b.stateFor(b.get(wid)).session = { token: 'PRIVATE_LEASE_TOKEN' };
  const result = await run(b, wid);
  assert.equal(result.comparison.missingCount, 1); assert.equal(result.comparison.changedCount, 1); assert.equal(result.comparison.extraCount, 1);
  assert.equal(check(result, 'game').level, 'warning'); assert.equal(check(result, 'session').level, 'warning');
  assert.equal(check(result, 'dirty').level, 'warning'); assert.equal(check(result, 'files').level, 'warning');
  assert.equal(await fs.readFile(path.join(bFolder, 'PrivateWorld', 'unexpected.dat'), 'utf8'), 'extra');
  assert.equal(result.report.includes('PRIVATE_LEASE_TOKEN'), false);
});

test('offline and auth failures never leak server messages or prevent local checks', async t => {
  const { b, wid } = await fixture(t); await b.pull(wid);
  const w = b.get(wid); w.key = 'DO_NOT_EXPORT_THIS';
  const unauthorized = await run(b, wid);
  assert.match(check(unauthorized, 'server').detail, /401/);
  assert.equal(unauthorized.localFiles, 5);
  w.server = 'http://127.0.0.1:1';
  const offline = await run(b, wid);
  assert.equal(check(offline, 'server').level, 'error'); assert.equal(offline.localFiles, 5);
  assert.equal(offline.report.includes(w.server), false);
});

test('report excludes secrets, names, custom path prefixes and arbitrary filenames', async t => {
  const { b, wid, root, bFolder } = await fixture(t); await b.pull(wid);
  const w = b.get(wid), r = b.stateFor(w);
  r.error = `Authorization: Bearer ${w.key} saveshare:PRIVATE_CODE /Users/PrivateUsername`;
  await fs.writeFile(path.join(bFolder, 'PrivateWorld', 'PrivateUsername.txt'), 'private contents');
  const result = await run(b, wid);
  for (const forbidden of [w.key, w.server, root, 'SecretDisplayName', 'PrivateWorld', 'PrivateAuthor', 'PrivateUsername', 'PRIVATE_CODE', 'private contents']) assert.equal(result.report.includes(forbidden), false, forbidden);
  assert.match(result.report, /<autre fichier>/);
  assert.ok(result.paths.configured.includes(root), 'only local UI keeps exact paths');
  assert.equal(sharedPath('C:\\Users\\PrivateUsername\\AppData\\LocalLow\\IronGate\\Valheim\\worlds_local\\PrivateWorld', 'PrivateWorld'), '<emplacement masqué>/worlds_local/<monde>');
  assert.equal(sharedPath('/Users/PrivateUsername/custom/PrivateWorld', 'PrivateWorld'), '<emplacement masqué>/<monde>');
});

test('limited hashes do not claim verified installation and legacy saves remain supported', async t => {
  const { b, wid } = await fixture(t, false); await b.pull(wid);
  const full = await run(b, wid); assert.equal(full.comparison.identical, true); assert.equal(full.versions.format, 'legacy');
  const partial = await run(b, wid, { hashBudget: 0 });
  assert.equal(partial.comparison.identical, false); assert.equal(partial.comparison.unverified, 2);
  assert.equal(check(partial, 'limits').level, 'warning');
});

test('symlinks and unreadable paths are not declared safe', async t => {
  const { b, wid, bFolder, root } = await fixture(t); await b.pull(wid);
  const f = path.join(bFolder, 'PrivateWorld', '_main.1.db2'); await fs.unlink(f);
  const outside = path.join(root, 'private.txt'); await fs.writeFile(outside, 'do not export');
  try { await fs.symlink(outside, f); }
  catch (e) { if (process.platform === 'win32' && e.code === 'EPERM') return t.skip('Symlinks unavailable'); throw e; }
  const result = await run(b, wid);
  assert.equal(check(result, 'files').level, 'warning'); assert.equal(result.comparison, undefined);
  assert.equal(await fs.readFile(outside, 'utf8'), 'do not export');
  b.get(wid).folder = path.join(root, 'does-not-exist');
  assert.equal(check(await run(b, wid), 'permissions').level, 'error');
});

test('comparison distinguishes unchecked files from hash mismatches; Windows default path is portable', () => {
  const files = [{ name: 'one', size: 1, hash: 'a' }];
  assert.equal(compare([{ name: 'one', size: 1, hash: null }], files).unverified, 1);
  assert.equal(compare([{ name: 'one', size: 1, hash: 'b' }], files).changed.length, 1);
  assert.equal(usualFolder('win32', 'C:\\Users\\Alice'), 'C:\\Users\\Alice\\AppData\\LocalLow\\IronGate\\Valheim\\worlds_local');
});
