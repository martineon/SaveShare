// Filesystem-only snapshot handling. Never interpret or rewrite Valheim's binary data.
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, id, worldName, safeRelative, MAX_FILES } = require('../shared/common.cjs');

const roots = w => [worldName(w.fileStem), `${w.fileStem}.db`, `${w.fileStem}.fwl`];
const stat = filename => fs.lstat(filename).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
async function inventory(w, { all = false } = {}) {
  const entries = [], existing = [];
  let total = 0;
  async function visit(name) {
    safeRelative(name);
    const filename = path.join(w.folder, name), s = await stat(filename);
    if (!s) fail('Sauvegarde modifiée pendant la lecture.');
    if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) fail('Les liens symboliques et fichiers spéciaux ne sont pas acceptés comme sauvegardes.');
    entries.push({ name, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino, directory: s.isDirectory() });
    if (entries.length > MAX_FILES + 1000) fail('Dossier trop volumineux (50 000 fichiers maximum).');
    if (s.isDirectory()) {
      for (const child of (await fs.readdir(filename)).sort()) await visit(`${name}/${child}`);
    } else {
      total += s.size;
      if (s.size > 1024 ** 3 || total > 16 * 1024 ** 3) fail('Sauvegarde trop volumineuse : 1 Gio par fichier, 16 Gio par monde.');
    }
  }
  const names = roots(w), folderStat = await stat(path.join(w.folder, names[0]));
  if (folderStat && (!folderStat.isDirectory() || folderStat.isSymbolicLink())) fail('Le dossier du monde doit être un vrai dossier, sans liens symboliques.');
  const format = folderStat ? 'folder' : 'legacy';
  for (const name of all ? names : format === 'folder' ? [names[0]] : names.slice(1)) {
    if (!await stat(path.join(w.folder, name))) continue;
    if (name !== names[0] && !(await stat(path.join(w.folder, name))).isFile()) fail('Les liens symboliques et les dossiers ne sont pas acceptés comme sauvegardes.');
    existing.push(name); await visit(name);
  }
  return { format, entries, existing };
}
const unchanged = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function copyRoots(w, destination, existing) {
  for (const name of existing) await fs.cp(path.join(w.folder, name), path.join(destination, name), { recursive: true, errorOnExist: true, force: false });
}
async function stageFiles(w, files, cache) {
  const stage = await fs.mkdtemp(path.join(w.folder, '.saveshare-stage-'));
  try {
    for (const f of files) {
      const dest = path.join(stage, safeRelative(f.name));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(path.join(cache, f.hash), dest);
    }
    return stage;
  } catch (e) { await fs.rm(stage, { recursive: true, force: true }); throw e; }
}
async function replaceRoots(w, stage, displaced) {
  for (const name of roots(w)) {
    const dest = path.join(w.folder, name);
    if (await stat(dest)) await fs.rename(dest, path.join(displaced, name));
  }
  for (const name of roots(w)) {
    const source = path.join(stage, name);
    if (await stat(source)) await fs.rename(source, path.join(w.folder, name));
  }
}
async function recoverSnapshot(w, journal) {
  // Preserve even files changed after the interruption; rollback is repeatable.
  await inventory(w, { all: true });
  const source = { ...w, folder: journal.backup };
  const original = await inventory(source, { all: true });
  if (JSON.stringify(original.existing) !== JSON.stringify(journal.existing)) fail('Copie de secours incomplète. Récupération manuelle requise.');
  const stage = await fs.mkdtemp(path.join(w.folder, '.saveshare-recovery-'));
  const displaced = path.join(w.folder, `.saveshare-interrupted-${id()}`);
  await fs.mkdir(displaced);
  try {
    await copyRoots(source, stage, journal.existing);
    await replaceRoots(w, stage, displaced);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
  // Do not delete displaced trees here: a user might have played after the crash.
}
module.exports = { inventory, unchanged, copyRoots, stageFiles, replaceRoots, recoverSnapshot };
