import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function launchVault(prefix: string, notes: Record<string, string>, folders: string[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  for (const folder of folders) await mkdir(path.join(vault, folder), { recursive: true });
  for (const [name, content] of Object.entries(notes)) {
    await mkdir(path.dirname(path.join(vault, name)), { recursive: true });
    await writeFile(path.join(vault, name), content);
  }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  return { app, vault, page: await app.firstWindow() };
}

test('inactive wikilinks show the note name while preserving full targets', async () => {
  const original = '# Inicio\n\n[[programacion/js]]\n\n[[programacion/js|JavaScript]]\n\n[[programacion/js.md#Tema]]\n\nTexto final\n';
  const { app, page, vault } = await launchVault('boveda-links-', { 'Inicio.md': original, 'programacion/js.md': '# JavaScript\n\n## Tema\n\nContenido destino\n' });
  try {
    await page.getByRole('button', { name: 'Inicio', exact: true }).click();
    const link = page.locator('[data-wiki-target="programacion/js"]');
    await expect(link).toHaveText('js');
    await expect(page.locator('[data-wiki-target="programacion/js|JavaScript"]')).toHaveText('JavaScript');
    await expect(page.locator('[data-wiki-target="programacion/js.md#Tema"]')).toHaveText('js');
    await link.click();
    await expect(page.locator('.cm-content')).toContainText('Contenido destino');
    await expect(page.locator('.note-path')).toContainText('programacion / js');
    await page.getByRole('button', { name: 'Inicio', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('Texto final');
    await expect(page.locator('.editor-wrap')).toHaveAttribute('aria-busy', 'false');
    await page.locator('.cm-line').filter({ has: link }).click({ position: { x: 220, y: 8 } });
    await expect(link).toHaveText('[[programacion/js]]');
    await page.keyboard.press('Control+End');
    await expect(link).toHaveText('js');
    await page.getByRole('button', { name: 'Vista en vivo', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('[[programacion/js]]');
    expect(await readFile(path.join(vault, 'Inicio.md'), 'utf8')).toBe(original);
  } finally { await app.close(); }
});

test('drag files and folders into subfolders and back to the vault root', async () => {
  const { app, page, vault } = await launchVault('boveda-drag-', { 'Nota.md': '# Nota\n\n', 'Destinos/Sub/Otra.md': 'Nota existente', 'Otras/Otra.md': 'No sobrescribir' }, ['Archivo']);
  const exists = (name: string) => stat(path.join(vault, name)).then(() => true, () => false);
  const content = (name: string) => readFile(path.join(vault, name), 'utf8').catch(() => '');
  const entry = (name: string) => page.locator(`[data-entry-path="${name}"]`);
  const folder = (name: string) => page.locator(`[data-drop-path="${name}"]`).first();
  try {
    await page.getByRole('button', { name: 'Destinos', exact: true }).click();
    await page.getByRole('button', { name: 'Nota', exact: true }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('Cambios antes de mover.');
    await entry('Nota.md').dragTo(folder('Destinos/Sub'));
    await expect(page.locator('.note-path')).toContainText('Destinos/Sub / Nota');
    await expect.poll(() => content('Destinos/Sub/Nota.md')).toContain('Cambios antes de mover.');
    expect(await exists('Nota.md')).toBe(false);
    await expect(entry('Destinos')).toHaveAttribute('draggable', 'true');
    await entry('Destinos').dragTo(folder('Archivo'));
    await expect(page.locator('.note-path')).toContainText('Archivo/Destinos/Sub / Nota');
    await expect.poll(() => content('Archivo/Destinos/Sub/Nota.md')).toContain('Cambios antes de mover.');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(' Y después de mover la carpeta.');
    await expect(entry('Archivo/Destinos/Sub/Nota.md')).toHaveAttribute('draggable', 'true');
    await entry('Archivo/Destinos/Sub/Nota.md').dragTo(page.locator('.vault-name[data-drop-path=""]'));
    await expect(page.locator('.note-path')).toHaveText('Nota');
    await expect.poll(() => content('Nota.md')).toContain('Y después de mover la carpeta.');
    // A folder cannot be dropped into its own descendants.
    await expect(entry('Archivo/Destinos')).toHaveAttribute('draggable', 'true');
    await entry('Archivo/Destinos').dragTo(folder('Archivo/Destinos/Sub'));
    expect(await exists('Archivo/Destinos/Sub/Otra.md')).toBe(true);
    expect(await exists('Archivo/Destinos/Sub/Destinos')).toBe(false);
    // Colliding names must surface an error and preserve both files.
    await entry('Archivo/Destinos/Sub/Otra.md').dragTo(folder('Otras'));
    await expect(page.getByRole('alert')).toContainText('Ya existe');
    expect(await content('Archivo/Destinos/Sub/Otra.md')).toBe('Nota existente');
    expect(await content('Otras/Otra.md')).toBe('No sobrescribir');
    await page.getByRole('button', { name: 'Cerrar aviso' }).click();
    const emptyRoot = page.locator('.tree-scroll[data-drop-path=""]');
    const rootBounds = await emptyRoot.boundingBox();
    if (!rootBounds) throw new Error('No se encuentra el espacio vacío del árbol.');
    await entry('Archivo/Destinos').dragTo(emptyRoot, { targetPosition: { x: 70, y: rootBounds.height - 18 } });
    await expect.poll(() => exists('Destinos/Sub/Otra.md')).toBe(true);
    expect(await exists('Archivo/Destinos')).toBe(false);
    await page.screenshot({ path: 'test-results/drag-and-drop.png', fullPage: true });
  } finally { await app.close(); }
});
