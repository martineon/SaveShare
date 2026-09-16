const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const semver = require('semver');

async function digest(file, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}
async function validateRelease(dir, version) {
  if (!semver.valid(version) || semver.prerelease(version)) throw new Error('This update channel requires a stable semantic version.');
  const required = [
    `SaveShare-${version}-win-x64.exe`,
    `SaveShare-${version}-mac-arm64.dmg`, `SaveShare-${version}-mac-x64.dmg`,
    `SaveShare-${version}-mac-arm64.zip`, `SaveShare-${version}-mac-x64.zip`
  ];
  const referenced = new Set();
  for (const name of ['latest.yml', 'latest-mac.yml']) {
    const metadata = yaml.load(await fs.promises.readFile(path.join(dir, name), 'utf8'));
    if (metadata.version !== version || !Array.isArray(metadata.files) || !metadata.files.length) throw new Error(`Invalid version or missing files in ${name}`);
    for (const file of metadata.files) {
      if (typeof file.url !== 'string' || file.url !== path.basename(file.url) || file.url.includes('\\') || !required.includes(file.url)) throw new Error(`Unexpected artifact in ${name}`);
      if (await digest(path.join(dir, file.url), 'sha512', 'base64') !== file.sha512) throw new Error(`Checksum mismatch: ${file.url}`);
      referenced.add(file.url);
    }
  }
  for (const file of required) if (!referenced.has(file)) throw new Error(`Missing update metadata for ${file}`);
  return required;
}
async function publish() {
  const version = require('../package.json').version;
  if (process.env.GITHUB_REF_NAME !== `v${version}` || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) throw new Error('The release tag must match package.json and an exact commit.');
  const dir = path.resolve('release-assets');
  await validateRelease(dir, version);
  const names = (await fs.promises.readdir(dir)).filter(name => /\.(exe|dmg|zip|blockmap|yml)$/.test(name)).sort();
  const sums = await Promise.all(names.map(async name => `${await digest(path.join(dir, name), 'sha256', 'hex')}  ${name}`));
  await fs.promises.writeFile(path.join(dir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  const notes = `docs/releases/v${version}.md`;
  await fs.promises.access(notes);
  const gh = args => execFileSync('gh', args, { stdio: 'inherit' });
  // An existing published release is never overwritten. Failed uploads stay drafts.
  gh(['release', 'create', `v${version}`, '--repo', 'martineon/SaveShare', '--verify-tag', '--target', process.env.GITHUB_SHA, '--draft', '--title', `SaveShare v${version}`, '--notes-file', notes, ...names.map(name => path.join(dir, name)), path.join(dir, 'SHA256SUMS.txt')]);
  gh(['release', 'edit', `v${version}`, '--repo', 'martineon/SaveShare', '--draft=false', '--latest']);
}
if (require.main === module) publish().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { validateRelease };
