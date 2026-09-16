const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Startup } = require('../desktop/startup.cjs');
const { WorldNotifications } = require('../desktop/notifications.cjs');
function setup(platform = 'win32', packaged = true) {
  const calls = [], config = {}; let settings = { openAtLogin: false }; let saves = 0;
  const app = { isPackaged: packaged, getLoginItemSettings: o => { calls.push(['get', o]); return settings; }, setLoginItemSettings: o => { calls.push(['set', o]); settings = { ...settings, openAtLogin: o.openAtLogin }; } };
  const startup = new Startup({ app, platform, execPath: 'C:\\SaveShare\\SaveShare.exe', config, save: async () => saves++ });
  return { startup, app, calls, config, settings: value => { settings = value; }, saves: () => saves };
}
test('installed app registers once at login, remembers opt out and respects OS changes', async () => {
  const f = setup(); await f.startup.init();
  assert.equal(f.startup.state().enabled, true); assert.equal(f.saves(), 1);
  assert.deepEqual(f.calls.find(c => c[0] === 'set')[1], { openAtLogin: true, path: 'C:\\SaveShare\\SaveShare.exe', args: [] });
  f.settings({ openAtLogin: true, executableWillLaunchAtLogin: false });
  await f.startup.init(); assert.equal(f.startup.state().enabled, false); assert.equal(f.saves(), 1);
  await f.startup.set(false); await f.startup.init(); assert.equal(f.config.launchAtLogin, false); assert.equal(f.saves(), 2);
  await assert.rejects(f.startup.set('true'), /invalide/);
});
test('development and unsupported platforms never change system startup settings', async () => {
  for (const f of [setup('darwin', false), setup('linux')]) {
    await f.startup.init(); assert.equal(f.startup.state().supported, false); assert.equal(f.calls.length, 0);
    await assert.rejects(f.startup.set(true), /Installez/);
  }
});
test('Mac pending approval and unsigned registration failures are reported honestly', async () => {
  const f = setup('darwin'); await f.startup.init();
  f.settings({ openAtLogin: true, status: 'requires-approval' });
  assert.equal(f.startup.state().enabled, false); assert.match(f.startup.state().message, /Autorisez/);
  f.settings({ openAtLogin: false, status: 'not-registered' });
  assert.match(f.startup.state().message, /non signée/);
});
test('startup API failure does not prevent the app from opening', async () => {
  const f = setup(); f.app.setLoginItemSettings = () => { throw Error('OS failure'); };
  await f.startup.init(); assert.match(f.startup.state().message, /OS failure/);
});
test('notification clicks open the world and failure uses a popup fallback', () => {
  const made = [], opened = [], fallback = [], announced = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; made.push(this); }
    show() { this.shown = true; }
  }
  const n = new WorldNotifications({ Notification, enabled: true, open: id => opened.push(id), announce: data => announced.push(data), fallback: data => fallback.push(data) });
  n.show({ worldId: 'one', name: 'Midgard' });
  assert.equal(made[0].shown, true); assert.equal(announced.length, 1);
  made[0].emit('click'); assert.deepEqual(opened, ['one']);
  made[0].emit('failed'); assert.equal(fallback[0].worldId, 'one'); assert.equal(n.active.size, 0);
  const mac = new WorldNotifications({ Notification, enabled: true, nativeEnabled: false, open() {}, announce() {}, fallback: data => fallback.push(data) });
  mac.show({ worldId: 'two', name: 'Asgard' });
  assert.equal(made.length, 1); assert.equal(fallback.length, 2);
});
