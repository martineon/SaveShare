const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const id = () => crypto.randomUUID();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
function worldName(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_ -]{1,80}$/u.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) fail('Nom de fichier du monde invalide.');
  return value;
}
function manifest(files, name) {
  worldName(name);
  if (!Array.isArray(files) || files.length !== 2) fail('Les deux fichiers .db et .fwl sont requis.');
  const expected = [`${name}.db`, `${name}.fwl`];
  for (const filename of expected) {
    const file = files.find(f => f && f.name === filename);
    if (!file || !isHash(file.hash) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 1024 ** 3) fail('Manifeste de sauvegarde invalide.');
  }
  return expected.map(name => { const f = files.find(f => f.name === name); return { name, hash: f.hash, size: f.size }; });
}
async function atomicJSON(filename, data) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${id()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, filename);
  } finally { await fs.rm(temp, { force: true }); }
}
const readJSON = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
function sameFiles(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every(f => b.some(g => g.name === f.name && g.hash === f.hash && g.size === f.size));
}
module.exports = { hash, id, fail, isHash, isId, worldName, manifest, atomicJSON, readJSON, sameFiles };
