import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PASSWORD = 'Synthetic whole vault password 47';
const SECRET = '# Private synthetic note\n\nUnicode: café 日本語 🔒\n\n## Target\n\nPrivate body token 82391\n';

async function fixture(idle?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'black-cobble-whole-private-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  await writeFile(path.join(vault, 'Public.md'), '# Public\n\n[[Hidden title]]\n\nEnd\n');
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined)),
    BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile'),
    ...(idle ? { BOVEDA_TEST_PRIVATE_TIMEOUT_MS: String(idle) } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Public', exact: true })).toBeVisible();
    return { app, page };
  };
  return { vault, root, launch, ...await launch() };
}

async function enterPrivate(page: Page) {
  await page.getByRole('button', { name: 'Privada', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.vault.getVault().then(v => v?.kind))).toBe('private');
}
async function setup(page: Page) {
  await enterPrivate(page);
  await page.getByRole('button', { name: 'Crear contraseña', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await dialog.getByLabel('Confirmar contraseña', { exact: true }).fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Crear contraseña', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return page.evaluate(async secret => {
    const session = await window.vault.getPrivateSession();
    await window.vault.createFolder('', 'Hidden folder');
    return window.vault.createPrivateCopy('Hidden folder', 'Hidden title', secret, session.sessionId!);
  }, SECRET);
}
async function diskText(root: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    parts.push(entry.name);
    const full = path.join(root, entry.name);
    parts.push(entry.isDirectory() ? await diskText(full) : await readFile(full, 'utf8'));
  }
  return parts.join('\n');
}

test('whole private vault hides names, folders and body; supports password changes and restart', async () => {
  const f = await fixture();
  let app: ElectronApplication | undefined = f.app;
  try {
    const page = f.page;
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await setup(page);
    await page.getByRole('button', { name: 'Hidden folder', exact: true }).click();
    await page.getByRole('button', { name: 'Hidden title', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('Private body token');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('Newest private edit 49273');
    await page.keyboard.press('Control+s');
    await expect(page.locator('.note-status')).toContainText('Guardado');
    const preferences = await page.evaluate(() => JSON.stringify(localStorage));
    expect(preferences).not.toContain('Hidden title');
    expect(preferences).not.toContain('Hidden folder');
    const stored = await diskText(path.join(f.vault, '.black-cobble-private'));
    for (const text of ['Hidden title', 'Hidden folder', 'Private body token', 'Newest private edit']) expect(stored).not.toContain(text);
    await page.screenshot({ path: 'test-results/whole-private-unlocked.png', fullPage: true });
    await page.getByRole('button', { name: 'Bloquear bóveda', exact: true }).first().click();
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    for (const text of ['Hidden title', 'Hidden folder', 'Private body token']) await expect(page.locator('body')).not.toContainText(text);
    expect(await page.evaluate(() => window.vault.listEntries())).toEqual([]);
    await page.screenshot({ path: 'test-results/whole-private-locked.png', fullPage: true });
    const denied = await page.evaluate(async () => {
      try { await window.vault.readNote('Hidden folder/Hidden title.md'); return false; } catch { return true; }
    });
    expect(denied).toBe(true);
    await page.getByRole('button', { name: 'Desbloquear bóveda', exact: true }).first().click();
    const unlock = page.getByRole('dialog');
    await unlock.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
    await unlock.getByRole('button', { name: 'Desbloquear bóveda', exact: true }).click();
    await expect(unlock).toHaveCount(0);
    await page.getByRole('button', { name: 'Cambiar contraseña', exact: true }).click();
    const change = page.getByRole('dialog');
    await change.getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
    await change.getByLabel('Nueva contraseña', { exact: true }).fill(`${PASSWORD} changed`);
    await change.getByLabel('Confirmar contraseña', { exact: true }).fill(`${PASSWORD} changed`);
    await change.getByRole('button', { name: 'Cambiar contraseña', exact: true }).click();
    await expect(change).toHaveCount(0);
    expect(errors).toEqual([]);
    await app.close(); app = undefined;
    const next = await f.launch(); app = next.app;
    await enterPrivate(next.page);
    expect(await next.page.evaluate(() => window.vault.listEntries())).toEqual([]);
    const result = await next.page.evaluate(async password => {
      let wrongRejected = false;
      try { await window.vault.unlockPrivateSession(password); } catch { wrongRejected = true; }
      await window.vault.unlockPrivateSession(`${password} changed`);
      return { wrongRejected, note: await window.vault.readNote('Hidden folder/Hidden title.md') };
    }, PASSWORD);
    expect(result.wrongRejected).toBe(true);
    expect(result.note.content).toContain('Newest private edit 49273');
  } finally { await app?.close(); }
});

test('inactivity clears the complete tree and stale writes fail; normal vault remains independent', async () => {
  const { app, page } = await fixture(2500);
  try {
    const note = await setup(page);
    await expect.poll(async () => (await page.evaluate(() => window.vault.getPrivateSession())).unlocked, { timeout: 10_000 }).toBe(false);
    await expect(page.locator('body')).not.toContainText('Hidden folder');
    expect(await page.evaluate(() => window.vault.listEntries())).toEqual([]);
    const rejected = await page.evaluate(async original => {
      try { await window.vault.writeNote(original.path, 'stale overwrite', original.version, original.sessionId); return false; } catch { return true; }
    }, note);
    expect(rejected).toBe(true);
    await page.getByRole('button', { name: 'Normal', exact: true }).click();
    await page.getByRole('button', { name: 'Public', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('Public');
    const entries = await page.evaluate(() => window.vault.listEntries());
    expect(JSON.stringify(entries)).not.toContain('Hidden');
    const denial = await page.evaluate(async () => {
      try { await window.vault.readNote('.black-cobble-private/Hidden folder/Hidden title.md'); return false; } catch { return true; }
    });
    expect(denial).toBe(true);
  } finally { await app.close(); }
});

test('private moves preserve links and normal moves do not need the private password', async () => {
  const { app, page, vault } = await fixture();
  try {
    await setup(page);
    const result = await page.evaluate(async () => {
      const session = await window.vault.getPrivateSession();
      await window.vault.createPrivateCopy('', 'Reference', '[[Hidden folder/Hidden title#Target|Alias]]', session.sessionId!);
      await window.vault.createFolder('', 'Archive');
      await window.vault.moveEntry('Hidden folder', 'Archive');
      const reference = await window.vault.readNote('Reference.md');
      let publicDenied = false;
      try { await window.vault.readNote('Public.md'); } catch { publicDenied = true; }
      return { reference, publicDenied };
    });
    expect(result.reference.content).toBe('[[Archive/Hidden folder/Hidden title#Target|Alias]]');
    expect(result.publicDenied).toBe(true);
    await page.getByRole('button', { name: 'Normal', exact: true }).click();
    expect((await page.evaluate(() => window.vault.getPrivateSession())).unlocked).toBe(false);
    await writeFile(path.join(vault, 'Reference.md'), '[[Public#Title|Shown]]');
    await page.evaluate(async () => { await window.vault.createFolder('', 'Archive'); await window.vault.moveEntry('Public.md', 'Archive'); });
    const link = await readFile(path.join(vault, 'Reference.md'), 'utf8');
    // Bare names remain valid across folders; verify navigation rather than forcing a rewrite.
    expect(link).toMatch(/\[\[(?:Archive\/)?Public#Title\|Shown\]\]/);
  } finally { await app.close(); }
});
