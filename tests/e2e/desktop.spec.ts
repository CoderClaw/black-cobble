import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('desktop vault, live editing and durable Markdown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'boveda-e2e-'));
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'Proyectos'), { recursive: true });
  await writeFile(path.join(vault, 'Inicio.md'), '# Mi bóveda\n\nUna nota con **negrita** y [[Proyectos/Idea|una idea]].\n\n- [ ] Revisar notas\n', 'utf8');
  await writeFile(path.join(vault, 'Proyectos', 'Idea.md'), '# Idea\n\nUna segunda nota.\n', 'utf8');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await expect.poll(() => page.evaluate(() => Boolean(window.vault))).toBe(true);
    await expect.poll(() => page.evaluate(() => window.vault.getVault().then(v => v?.path))).toBe(vault);
    await expect(page.getByText('Inicio', { exact: true }).first()).toBeVisible();
    await page.getByText('Inicio', { exact: true }).first().click();
    await expect(page.locator('.cm-editor')).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('Mi bóveda');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('Texto persistente desde Electron.');
    await page.keyboard.press('Control+s');
    await expect.poll(() => readFile(path.join(vault, 'Inicio.md'), 'utf8')).toContain('Texto persistente desde Electron.');
    await expect(page.locator('.cm-md-strong')).toContainText('negrita');
    await page.getByRole('checkbox', { name: 'Completar tarea' }).click();
    await expect(page.getByRole('checkbox', { name: 'Marcar tarea pendiente' })).toBeChecked();
    await expect.poll(() => readFile(path.join(vault, 'Inicio.md'), 'utf8')).toContain('- [x]');
    await page.locator('[data-wiki-target]').click();
    await expect(page.locator('.cm-content')).toContainText('Una segunda nota.');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(' Guardado al navegar.');
    await page.getByRole('button', { name: 'Inicio', exact: true }).click();
    await expect.poll(() => readFile(path.join(vault, 'Proyectos', 'Idea.md'), 'utf8')).toContain('Guardado al navegar.');
    await page.getByRole('button', { name: 'Vista en vivo', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('**negrita**');
    await page.getByRole('button', { name: 'Código fuente', exact: true }).click();
    await page.getByRole('button', { name: 'Tema claro', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.screenshot({ path: 'test-results/desktop-light.png', fullPage: true });
    await page.getByRole('button', { name: 'Tema oscuro', exact: true }).click();
    // Exercise the same restricted bridge used by the UI, against real files.
    await page.evaluate(async () => {
      await window.vault.createFolder('Proyectos', 'Subcarpeta');
      const note = await window.vault.createNote('Proyectos/Subcarpeta', 'Prueba');
      await window.vault.writeNote(note.path, '# Persistencia\n\n[[Inicio]]', note.version);
      await window.vault.renameEntry(note.path, 'Renombrada');
      await window.vault.moveEntry('Proyectos/Subcarpeta/Renombrada.md', '');
    });
    expect(await readFile(path.join(vault, 'Renombrada.md'), 'utf8')).toBe('# Persistencia\n\n[[Inicio]]');
    const conflict = await page.evaluate(async () => {
      const note = await window.vault.readNote('Renombrada.md');
      await window.vault.writeNote(note.path, 'Cambio 1', note.version);
      try { await window.vault.writeNote(note.path, 'Cambio 2', note.version); return false; }
      catch { return true; }
    });
    expect(conflict).toBe(true);
    const traversalBlocked = await page.evaluate(async () => {
      try { await window.vault.readNote('../outside.md'); return false; } catch { return true; }
    });
    expect(traversalBlocked).toBe(true);
    await page.screenshot({ path: 'test-results/desktop-dark.png', fullPage: true });
    expect(errors).toEqual([]);
    await app.close();
    app = undefined;
    app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
    const reopened = await app.firstWindow();
    await expect(reopened.locator('.note-status')).toContainText('Guardado');
    await expect.poll(() => reopened.evaluate(() => window.vault.readNote('Inicio.md').then(n => n.content))).toContain('Texto persistente desde Electron.');
  } finally {
    if (app) await app.close();
  }
});

test('UI folders, missing links, external conflicts and close flush', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'boveda-workflow-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  await writeFile(path.join(vault, 'Inicio.md'), '# Inicio\n\n[[Carpeta/Nueva|Crear destino]]\n\nFinal\n');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  let closed = false;
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Inicio', exact: true }).click();
    await page.locator('[data-wiki-target]').click();
    await expect(page.getByRole('heading', { name: 'Crear nota enlazada' })).toBeVisible();
    await page.getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(page.locator('.note-path')).toContainText('Nueva');
    await page.locator('.cm-content').click();
    await page.keyboard.insertText('# Creada desde enlace\n');
    await page.getByRole('button', { name: 'Acciones del archivo' }).click();
    await page.getByRole('menuitem', { name: 'Renombrar' }).click();
    await page.getByLabel('Nombre', { exact: true }).fill('Renombrada');
    await page.getByRole('button', { name: 'Renombrar', exact: true }).click();
    await expect.poll(() => readFile(path.join(vault, 'Carpeta', 'Renombrada.md'), 'utf8').catch(() => '')).toContain('Creada desde enlace');
    await page.getByRole('button', { name: 'Acciones del archivo' }).click();
    await page.getByRole('menuitem', { name: 'Mover', exact: true }).click();
    await page.getByLabel('Carpeta de destino').selectOption('');
    await page.getByRole('button', { name: 'Mover', exact: true }).click();
    await expect(page.locator('.note-path')).toHaveText('Renombrada');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('Mi cambio local');
    await writeFile(path.join(vault, 'Renombrada.md'), '# Cambio externo\n');
    await expect(page.getByRole('button', { name: 'Guardar una copia' })).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('Mi cambio local');
    await page.getByRole('button', { name: 'Guardar una copia' }).click();
    await expect(page.locator('.note-path')).toContainText('Renombrada copia');
    expect(await readFile(path.join(vault, 'Renombrada.md'), 'utf8')).toBe('# Cambio externo\n');
    expect(await readFile(path.join(vault, 'Renombrada copia.md'), 'utf8')).toContain('Mi cambio local');
    await page.getByRole('button', { name: 'Inicio', exact: true }).click();
    await writeFile(path.join(vault, 'Inicio.md'), '# Recargada desde fuera\n');
    await expect(page.locator('.cm-content')).toContainText('Recargada desde fuera');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('Guardado al cerrar.');
    await app.close();
    closed = true;
    expect(await readFile(path.join(vault, 'Inicio.md'), 'utf8')).toContain('Guardado al cerrar.');
  } finally {
    if (!closed) await app.close();
  }
});

test('development server mounts React under CSP and handles early close', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ server: { port: 5173 } });
  await server.listen();
  const root = await mkdtemp(path.join(tmpdir(), 'boveda-dev-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile'), VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByText('La bóveda está vacía.')).toBeVisible();
    expect(errors).toEqual([]);
    await app.close();
    app = undefined;
    app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
    // Deliberately close without waiting for React's first render.
    await app.firstWindow();
    await app.close();
    app = undefined;
  } finally {
    if (app) await app.close();
    await server.close();
  }
});

test('saving a copy of a note other tools placed in a folder named with # goes to the vault root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'boveda-copy-unlinkable-'));
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'C#'), { recursive: true });
  await writeFile(path.join(vault, 'C#', 'Apuntes #1.md'), '# Apuntes\n\n[[../Raíz]]\n');
  await writeFile(path.join(vault, 'Raíz.md'), '# Raíz\n');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'C#', exact: true }).click();
    await page.getByRole('button', { name: 'Apuntes #1', exact: true }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('Mi cambio local');
    await writeFile(path.join(vault, 'C#', 'Apuntes #1.md'), '# Cambio externo\n');
    await page.getByRole('button', { name: 'Guardar una copia' }).click();
    // New names never carry # ^ [ ] |, and a folder named with them accepts no new notes.
    await expect(page.locator('.note-path')).toContainText('Apuntes 1 copia');
    const copy = await readFile(path.join(vault, 'Apuntes 1 copia.md'), 'utf8');
    expect(copy).toContain('Mi cambio local');
    // From the root, ../Raíz no longer resolves: the copy's link was adapted to keep its destination.
    expect(copy).toContain('[[/Raíz]]');
    expect(await readFile(path.join(vault, 'C#', 'Apuntes #1.md'), 'utf8')).toBe('# Cambio externo\n');
  } finally { await app.close(); }
});

test('a copy whose link would point at another note is refused without leaving an empty note', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'boveda-copy-refused-'));
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'C#'), { recursive: true });
  // From the root, ./Otra would reach the root Otra.md instead of C#/Otra.md.
  await writeFile(path.join(vault, 'C#', 'Fuente.md'), '# Fuente\n\n[[./Otra]]\n');
  await writeFile(path.join(vault, 'C#', 'Otra.md'), '# Otra en C#\n');
  await writeFile(path.join(vault, 'Otra.md'), '# Otra en la raíz\n');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'C#', exact: true }).click();
    await page.getByRole('button', { name: 'Fuente', exact: true }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('Mi cambio local');
    await writeFile(path.join(vault, 'C#', 'Fuente.md'), '# Cambio externo\n');
    await page.getByRole('button', { name: 'Guardar una copia' }).click();
    await expect(page.locator('body')).toContainText('# ^ [ ] |');
    expect((await readdir(vault)).sort()).toEqual(['C#', 'Otra.md']);
    await expect(page.locator('.cm-content')).toContainText('Mi cambio local');
    // Leave the conflict the usual way so the app can close without asking about it.
    await page.getByRole('button', { name: 'Descartar y recargar' }).click();
    await expect(page.locator('.cm-content')).toContainText('Cambio externo');
  } finally { await app.close(); }
});
