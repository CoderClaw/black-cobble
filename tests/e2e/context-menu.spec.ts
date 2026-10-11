import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function launch(seed: (vault: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'black-cobble-context-menu-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  await seed(vault);
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  return { app, vault, page: await app.firstWindow() };
}

test('background and folder context menus create in the right parent', async () => {
  const { app, vault, page } = await launch(async vault => {
    await mkdir(path.join(vault, 'Proyectos'));
    await writeFile(path.join(vault, 'Proyectos', 'Existente.md'), '# Existente\n');
  });
  try {
    const menu = page.getByRole('menu');
    await expect(page.getByRole('button', { name: 'Proyectos', exact: true })).toBeVisible();
    // Empty area of the tree: both actions target the vault root.
    const tree = page.locator('nav.tree-scroll');
    const box = (await tree.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 10, { button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Nueva nota', 'Nueva carpeta']);
    await expect(menu.getByRole('menuitem', { name: 'Nueva nota' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Nueva carpeta' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Nueva nota' })).toBeFocused();
    await menu.getByRole('menuitem', { name: 'Nueva carpeta' }).click();
    await expect(menu).toHaveCount(0);
    await page.getByLabel('Nombre', { exact: true }).fill('Raiz');
    await page.getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await stat(path.join(vault, 'Raiz'))).isDirectory()).toBe(true);
    await expect(page.getByRole('button', { name: 'Raiz', exact: true })).toBeVisible();

    // The vault name behaves like the background even with another folder selected.
    await page.getByRole('button', { name: 'Proyectos', exact: true }).click();
    await page.locator('.vault-name').click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Nueva nota', 'Nueva carpeta']);
    await menu.getByRole('menuitem', { name: 'Nueva nota' }).click();
    await page.getByLabel('Nombre', { exact: true }).fill('En raiz');
    await page.getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await stat(path.join(vault, 'En raiz.md'))).isFile()).toBe(true);

    // A folder row creates inside itself, then lists its own actions after a separator.
    await page.getByRole('button', { name: 'Raiz', exact: true }).click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Nueva nota', 'Nueva carpeta', 'Renombrar', 'Mover', 'Papelera']);
    await expect(menu.getByRole('separator')).toHaveCount(1);
    // Escape returns focus to the row that opened the menu.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Raiz', exact: true })).toBeFocused();
    // The whole row counts, including its chevron: never the root menu.
    await page.getByRole('button', { name: /^(Expandir|Contraer) Proyectos$/ }).click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Nueva nota', 'Nueva carpeta', 'Renombrar', 'Mover', 'Papelera']);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Proyectos', exact: true }).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Nueva nota' }).click();
    await page.getByLabel('Nombre', { exact: true }).fill('Dentro');
    await page.getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await stat(path.join(vault, 'Proyectos', 'Dentro.md'))).isFile()).toBe(true);
    await expect(page.getByRole('button', { name: 'Dentro', exact: true })).toBeVisible();
    await expect(page.locator('.note-path')).toContainText('Dentro');
  } finally { await app.close(); }
});

test('note context menu offers only entry actions and Escape closes it', async () => {
  const { app, page } = await launch(async vault => { await writeFile(path.join(vault, 'Nota.md'), '# Nota\n'); });
  try {
    const menu = page.getByRole('menu');
    const note = page.getByRole('button', { name: 'Nota', exact: true });
    await note.click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Renombrar', 'Mover', 'Papelera']);
    await expect(menu.getByRole('separator')).toHaveCount(0);
    const position = await menu.boundingBox();
    const row = (await note.boundingBox())!;
    expect(position!.x).toBeGreaterThanOrEqual(row.x);
    expect(position!.y).toBeGreaterThanOrEqual(row.y);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // Clicking outside closes it too, and the toolbar dropdown keeps working.
    await note.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.locator('.note-toolbar').click();
    await expect(menu).toHaveCount(0);
    await page.getByRole('button', { name: 'Acciones del archivo' }).click();
    await expect(menu.getByRole('menuitem')).toHaveText(['Renombrar', 'Mover', 'Papelera']);
    expect((await menu.evaluate(element => getComputedStyle(element).position))).toBe('absolute');
    await page.getByRole('button', { name: 'Cerrar menú' }).click();
    await note.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Renombrar' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(menu).toHaveCount(0);
  } finally { await app.close(); }
});

test('context menu stays inside the viewport and opens on an empty vault', async () => {
  const { app, page } = await launch(async () => {});
  try {
    await expect(page.getByText('La bóveda está vacía.')).toBeVisible();
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await page.locator('nav.tree-scroll').click({ button: 'right', position: { x: 20, y: 20 } });
    await expect(page.getByRole('menuitem', { name: 'Nueva nota' })).toBeVisible();
    await page.mouse.click(size.width - 2, size.height - 2, { button: 'right' });
    // Outside the tree the click only closes the menu.
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.evaluate(() => {
      const tree = document.querySelector('nav.tree-scroll')!;
      tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: window.innerWidth - 1, clientY: window.innerHeight - 1 }));
    });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
  } finally { await app.close(); }
});
