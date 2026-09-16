const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Updates, installBlockReason } = require('../desktop/updates.cjs');

function fixture(platform = 'win32', packaged = true) {
  const updater = new EventEmitter(); let checks = 0, installs = 0, opened;
  updater.checkForUpdates = async () => { checks++; updater.emit('update-not-available'); return {}; };
  updater.quitAndInstall = (silent, relaunch) => { assert.equal(silent, false); assert.equal(relaunch, true); installs++; };
  const updates = new Updates({ updater, version: '0.2.0', packaged, platform, openExternal: async url => { opened = url; } });
  return { updater, updates, checks: () => checks, installs: () => installs, opened: () => opened };
}
test('development builds never contact the update server', async () => {
  const f = fixture('win32', false); await f.updates.check();
  assert.equal(f.checks(), 0); assert.equal(f.updates.state().status, 'disabled');
});
test('Windows downloads automatically but ordinary quit never installs', async () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, true); assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowDowngrade, false); assert.equal(f.updater.allowPrerelease, false);
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '0.3.0' });
    return { downloadPromise: Promise.resolve().then(() => {
      f.updater.emit('download-progress', { percent: 45.9 }); assert.equal(f.updates.state().progress, 45);
      f.updater.emit('update-downloaded', { version: '0.3.0' });
    }) };
  };
  await f.updates.check(); assert.equal(f.updates.state().status, 'ready'); assert.equal(f.installs(), 0);
  f.updates.install(); assert.equal(f.installs(), 1); assert.equal(f.updates.installing, true);
});
test('Mac checks for updates but opens only the official release page', async () => {
  const f = fixture('darwin'); assert.equal(f.updater.autoDownload, false);
  f.updater.emit('update-available', { version: '0.3.0' });
  assert.equal(f.updates.state().status, 'available');
  await f.updates.openDownload(); assert.equal(f.opened(), 'https://github.com/martineon/SaveShare/releases/tag/v0.3.0');
  assert.throws(() => f.updates.install(), /Aucune mise à jour/);
});
test('bad versions cannot open external URLs or downgrade', async () => {
  const f = fixture('darwin');
  for (const version of ['https://bad.example', '../../bad', '0.1.0', '0.2.0']) f.updater.emit('update-available', { version });
  await assert.rejects(f.updates.openDownload(), /Vérifiez/); assert.equal(f.opened(), undefined);
});
test('failed downloads are handled and can be retried', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => ({ downloadPromise: Promise.reject(new Error('checksum mismatch')) });
  await f.updates.check(); assert.equal(f.updates.state().status, 'error'); assert.equal(f.installs(), 0);
  f.updater.checkForUpdates = async () => { f.updater.emit('update-not-available'); return {}; };
  await f.updates.check(); assert.equal(f.updates.state().status, 'current');
});
test('repeated checks cannot interrupt a download or ready update', async () => {
  const f = fixture();
  f.updater.emit('update-available', { version: '0.3.0' }); await f.updates.check(); assert.equal(f.checks(), 0);
  f.updater.emit('update-downloaded', { version: '0.3.0' }); await f.updates.check(); assert.equal(f.checks(), 0);
});
test('installation is blocked during transfers, sessions, or Valheim', () => {
  assert.match(installBlockReason({ busy: true, worlds: [] }, false), /synchronisation/);
  assert.match(installBlockReason({ busy: false, worlds: [{ active: true }] }, false), /session/);
  assert.match(installBlockReason({ busy: false, worlds: [] }, true), /Valheim/);
  assert.equal(installBlockReason({ busy: false, worlds: [{ active: false }] }, false), null);
});
test('native installer failure returns a usable error state', () => {
  const f = fixture(); f.updater.emit('update-downloaded', { version: '0.3.0' });
  f.updater.quitAndInstall = () => { f.updater.emit('error', new Error('installer failed')); };
  f.updates.install(); assert.equal(f.updates.installing, false); assert.equal(f.updates.state().status, 'error');
});
