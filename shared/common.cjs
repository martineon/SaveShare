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
const MAX_FILES = 50_000;
function saveFormat(value = 'legacy') {
  if (!['legacy', 'folder'].includes(value)) fail('Format de sauvegarde inconnu. Mettez SaveShare à jour.');
  return value;
}
function safeRelative(name) {
  if (typeof name !== 'string' || name.length > 240) fail('Chemin de sauvegarde invalide.');
  const parts = name.split('/');
  if (parts.length > 9 || parts.some(p => !p || p === '.' || p === '..' || /[\\<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) fail('Chemin de sauvegarde invalide.');
  return name;
}
function folderComplete(names, stem) {
  const prefix = `${stem}/_main.`;
  const generations = new Map();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)\.(fwl2|db2|chunks|ok)$/.exec(name.slice(prefix.length));
    if (match) { const n = BigInt(match[1]); if (!generations.has(n)) generations.set(n, new Set()); generations.get(n).add(match[2]); }
  }
  const latest = [...generations.keys()].sort((a, b) => a < b ? 1 : a > b ? -1 : 0)[0];
  if (latest === undefined || generations.get(latest).size !== 4) fail('Dossier Valheim incomplet : attendez la fin de la sauvegarde (_main.N.fwl2, .db2, .chunks et .ok), puis réessayez.');
}
function manifest(files, name, format = 'legacy') {
  worldName(name);
  saveFormat(format);
  if (format === 'folder') {
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) fail('Manifeste de dossier invalide (50 000 fichiers maximum).');
    const seen = new Set(), paths = new Set(), spelling = new Map(); let total = 0;
    const result = files.map(f => {
      if (!f || !isHash(f.hash) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 1024 ** 3) fail('Manifeste de sauvegarde invalide.');
      safeRelative(f.name);
      if (!f.name.startsWith(`${name}/`)) fail('Chemin hors du dossier du monde.');
      const key = f.name.normalize('NFC').toLowerCase();
      if (seen.has(key)) fail('Chemins de sauvegarde en double.');
      seen.add(key); total += f.size;
      const parts = key.split('/');
      const originals = f.name.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const normalized = parts.slice(0, i).join('/'), original = originals.slice(0, i).join('/');
        if (spelling.has(normalized) && spelling.get(normalized) !== original) fail('Chemins incompatibles entre Windows et Mac.');
        spelling.set(normalized, original);
      }
      for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/'));
      return { name: f.name, hash: f.hash, size: f.size };
    });
    if (total > 16 * 1024 ** 3 || [...paths].some(p => seen.has(p))) fail('Manifeste de dossier invalide.');
    folderComplete(result.map(f => f.name), name);
    return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
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
  const indexed = new Map(b.map(f => [f.name, f]));
  return indexed.size === b.length && a.every(f => { const g = indexed.get(f.name); return g && g.hash === f.hash && g.size === f.size; });
}
module.exports = { hash, id, fail, isHash, isId, worldName, manifest, atomicJSON, readJSON, sameFiles, saveFormat, safeRelative, folderComplete, MAX_FILES };
