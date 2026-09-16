const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateRelease } = require('../scripts/publish-release.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'saveshare-release-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const names = ['win-x64.exe', 'mac-arm64.dmg', 'mac-x64.dmg', 'mac-arm64.zip', 'mac-x64.zip'].map(name => `SaveShare-0.2.0-${name}`);
  const files = [];
  for (const name of names) {
    const content = Buffer.from(name); await fs.writeFile(path.join(dir, name), content);
    files.push({ url: name, sha512: crypto.createHash('sha512').update(content).digest('base64') });
  }
  await fs.writeFile(path.join(dir, 'latest.yml'), JSON.stringify({ version: '0.2.0', files: files.slice(0, 1) }));
  await fs.writeFile(path.join(dir, 'latest-mac.yml'), JSON.stringify({ version: '0.2.0', files: files.slice(1) }));
  return { dir, names, files };
}
test('release validation accepts metadata matching every architecture', async t => {
  const { dir, names } = await fixture(t); assert.deepEqual(await validateRelease(dir, '0.2.0'), names);
});
test('release validation refuses corrupted installers', async t => {
  const { dir, names } = await fixture(t); await fs.writeFile(path.join(dir, names[0]), 'corrupted');
  await assert.rejects(validateRelease(dir, '0.2.0'), /Checksum mismatch/);
});
test('release validation refuses missing architectures and mismatched versions', async t => {
  const { dir, files } = await fixture(t);
  await fs.writeFile(path.join(dir, 'latest-mac.yml'), JSON.stringify({ version: '0.2.0', files: files.slice(1, 3) }));
  await assert.rejects(validateRelease(dir, '0.2.0'), /Missing update metadata/);
  await assert.rejects(validateRelease(dir, '0.3.0'), /Invalid version/);
});
