import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('private UI clears names, folder state, search and remote images on lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'black-cobble-vault-ui-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  await writeFile(path.join(vault, 'Normal visible.md'), '# Normal visible\n');
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const imageUrl = 'https://example.test/private-image.png';
  const imageRequests: string[] = [];
  page.on('request', request => { if (request.url() === imageUrl) imageRequests.push(request.url()); });
  const password = 'Synthetic UI password 29674';
  const folder = 'Sensitive folder 58293';
  const title = 'Sensitive title 91735';
  const secret = 'Sensitive body 64821';
  try {
    await expect(page.getByRole('button', { name: 'Normal visible', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Privada', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Normal visible', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Crear contraseña', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Contraseña', { exact: true }).fill(password);
    await dialog.getByLabel('Confirmar contraseña', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: 'Crear contraseña', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Nueva carpeta', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('input').fill(folder);
    await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
    await page.getByRole('button', { name: 'Nueva nota', exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await dialog.locator('input').fill(title);
    await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(`${secret}\n\n![Remote private image](${imageUrl})\n\nEdit`);
    await expect(page.locator('.cm-content')).toContainText(secret);
    await expect(page.locator(`[data-link-target="${imageUrl}"]`)).toHaveCount(1);
    await expect(page.locator('.cm-md-image img')).toHaveCount(0);
    await expect(page.locator(`.cm-content img[src="${imageUrl}"]`)).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Buscar archivos' }).fill(title);
    await page.getByRole('button', { name: 'Acciones del archivo' }).click();
    await page.getByRole('menuitem', { name: 'Renombrar', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // An automatic main-process lock must also remove an open sensitive dialog.
    await page.evaluate(() => window.vault.lockPrivateSession());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(folder);
    await expect(page.locator('body')).not.toContainText(title);
    await expect(page.locator('body')).not.toContainText(secret);
    await expect(page.locator('[data-entry-path]')).toHaveCount(0);
    const preferences = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    for (const hidden of [folder, title, secret, '.black-cobble-private']) expect(preferences).not.toContain(hidden);
    await page.getByRole('button', { name: 'Normal', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Normal visible', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Privada', exact: true }).click();
    await page.getByRole('button', { name: 'Desbloquear bóveda', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Contraseña', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: 'Desbloquear bóveda', exact: true }).click();
    await expect(page.getByRole('button', { name: folder, exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Buscar archivos' })).toHaveValue('');
    await expect(page.getByRole('button', { name: title, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: folder, exact: true }).click();
    await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Normal visible', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: title, exact: true }).click();
    await page.getByRole('button', { name: 'Acciones del archivo' }).click();
    await page.getByRole('menuitem', { name: 'Eliminar', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('No se puede recuperar.');
    await expect(page.getByRole('button', { name: 'Eliminar permanentemente' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n[[');
    await page.getByRole('button', { name: 'Bloquear bóveda', exact: true }).click();
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    // Cross CodeMirror's delayed completion query after its editor is destroyed.
    await page.waitForTimeout(250);
    expect(imageRequests).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('typing then changing notes leaves no deferred editor errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'black-cobble-editor-cleanup-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  for (const name of ['First', 'Second']) await writeFile(path.join(vault, `${name}.md`), `# ${name}\n`);
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'First', exact: true }).click();
    for (const name of ['Second', 'First', 'Second', 'First']) {
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\n[[');
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.locator('.note-path')).toHaveText(name);
    }
    await page.getByRole('button', { name: 'Vista en vivo', exact: true }).click();
    await page.getByRole('button', { name: 'Código fuente', exact: true }).click();
    await page.getByRole('button', { name: 'Tema claro', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.waitForTimeout(250);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('editing immediately after moving a note and renaming its link target uses the rewritten content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'black-cobble-live-link-move-'));
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'Folder'), { recursive: true });
  await writeFile(path.join(vault, 'Folder', 'Source.md'), '# Source\n\n[[../Target]]\n\nEdit\n');
  await writeFile(path.join(vault, 'Target.md'), '# Target\n');
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Folder', exact: true }).click();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await page.getByRole('button', { name: 'Vista en vivo', exact: true }).click();
    await page.getByRole('button', { name: 'Acciones del archivo' }).click();
    await page.getByRole('menuitem', { name: 'Mover', exact: true }).click();
    await page.getByLabel('Carpeta de destino').selectOption('');
    await page.getByRole('button', { name: 'Mover', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Type before the watcher refresh can replace the old content/version.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('Typed immediately after move.');
    await page.keyboard.press('Control+s');
    await expect.poll(() => readFile(path.join(vault, 'Source.md'), 'utf8')).toContain('Typed immediately after move.');
    expect(await readFile(path.join(vault, 'Source.md'), 'utf8')).toContain('[[/Target]]');
    await expect(page.getByRole('button', { name: 'Guardar una copia', exact: true })).toHaveCount(0);
    // Rename another note while Source stays open, changing its inbound link.
    await page.getByRole('button', { name: 'Target', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Renombrar', exact: true }).click();
    await page.getByLabel('Nombre', { exact: true }).fill('Destination');
    await page.getByRole('button', { name: 'Renombrar', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(' Typed immediately after target rename.');
    await page.keyboard.press('Control+s');
    await expect.poll(() => readFile(path.join(vault, 'Source.md'), 'utf8')).toContain('Typed immediately after target rename.');
    expect(await readFile(path.join(vault, 'Source.md'), 'utf8')).toContain('[[/Destination]]');
    await expect(page.getByRole('button', { name: 'Guardar una copia', exact: true })).toHaveCount(0);
  } finally { await app.close(); }
});
