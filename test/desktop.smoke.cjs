const { _electron: electron } = require('playwright');
const { expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createServer } = require('../server/index.cjs');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saveshare-desktop-'));
  const game = path.join(root, 'worlds_local'); await fs.mkdir(game);
  await fs.writeFile(path.join(game, 'Midgard.db'), 'The longhouse, day one');
  await fs.writeFile(path.join(game, 'Midgard.fwl'), 'world seed');
  const adminToken = 'desktop-test-key-at-least-32-characters';
  const server = createServer({ dataDir: path.join(root, 'server'), adminToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, SAVESHARE_TEST_MODE: '1', SAVESHARE_TEST_DATA: path.join(root, 'client') } });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await expect(page.getByText('Le même monde. Toute votre tribu.')).toBeVisible();
    await fs.mkdir(path.join(__dirname, '../artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../artifacts/desktop-empty.png') });
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, path.join(game, 'Midgard.fwl'));
    await page.getByText('Connecter mon premier monde').click();
    await page.locator('#author').fill('Martin');
    await page.locator('#server').fill(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#admin-token').fill(adminToken);
    await page.locator('#name').fill('Les Vikings du dimanche');
    await page.locator('#choose-folder').click();
    await page.locator('#submit-world').click();
    await expect(page.locator('dialog')).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Les Vikings du dimanche' })).toBeVisible();
    await page.getByRole('button', { name: 'Prendre la session' }).click();
    await expect(page.getByText('Première sauvegarde', { exact: true })).toBeVisible();
    await fs.writeFile(path.join(game, 'Midgard.db'), 'The longhouse and the harbor, day two');
    await page.getByRole('button', { name: 'Terminer ma session' }).click();
    await expect(page.getByText('Fin de session', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Restaurer' }).click();
    await expect(page.getByText(/^Restauration de /)).toBeVisible();
    assert.equal(await fs.readFile(path.join(game, 'Midgard.db'), 'utf8'), 'The longhouse, day one');
    await expect(page.getByRole('button', { name: 'Prendre la session' })).toBeEnabled();
    // Intercept clipboard writes to keep the user's clipboard untouched.
    await app.evaluate(({ clipboard }) => { clipboard.writeText = text => { globalThis.testInvitation = text; }; });
    await page.getByRole('button', { name: 'Inviter un ami' }).click();
    const invitation = await app.evaluate(() => globalThis.testInvitation); assert.match(invitation, /^saveshare:/);
    await page.locator('#toast').evaluate(el => el.hidden = true);
    await page.screenshot({ path: path.join(__dirname, '../artifacts/desktop-world.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Desktop smoke passed: create, session, publish, restore, invite; no renderer errors.');
  } finally {
    if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
