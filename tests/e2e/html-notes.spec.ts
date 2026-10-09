import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function launchVault(prefix: string, notes: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  for (const [name, content] of Object.entries(notes)) await writeFile(path.join(vault, name), content);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  return { app, vault, page: await app.firstWindow() };
}

test('creates and edits HTML notes linked with Markdown notes', async () => {
  const { app, page, vault } = await launchVault('boveda-html-', { 'Diario.md': '# Diario\n\nVer [[Pagina.html|la página]]\n' });
  const content = (name: string) => readFile(path.join(vault, name), 'utf8').catch(() => '');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Diario', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Nueva nota', exact: true }).first().click();
    let dialog = page.getByRole('dialog');
    await dialog.locator('input').fill('Pagina');
    await dialog.getByRole('radio', { name: /HTML/ }).click();
    await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.html-content')).toBeVisible();
    await expect(page.locator('[data-entry-path="Pagina.html"]')).toContainText('HTML');

    const editor = page.locator('.html-content');
    await editor.click();
    await page.keyboard.type('# Portada');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Texto con **negrita** y enlace a [[Dia');
    await expect(page.locator('.wiki-suggest')).toContainText('Diario');
    await page.keyboard.press('Enter');
    await page.keyboard.type('y fin.');
    await expect(editor.locator('h1')).toHaveText('Portada');
    await expect(editor.locator('strong')).toHaveText('negrita');
    await expect(editor.locator('a.wikilink[data-wikilink="Diario"]')).toHaveText('Diario');
    await expect.poll(() => content('Pagina.html')).toContain('<a class="wikilink" data-wikilink="Diario">Diario</a>');
    const saved = await content('Pagina.html');
    expect(saved).toMatch(/^<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">/);
    expect(saved).toContain('<title>Pagina</title>');
    expect(saved).toContain('<h1>Portada</h1>\n<p>Texto con <strong>negrita</strong>');
    await expect(page.locator('.note-status')).toContainText('10 palabras');

    // The Markdown link resolves to the HTML note, and the HTML wikilink opens the Markdown note.
    await editor.locator('a.wikilink').click();
    await expect(page.locator('.cm-content')).toContainText('Diario');
    await page.locator('[data-wiki-target="Pagina.html|la página"]').click();
    await expect(page.locator('.html-content h1')).toHaveText('Portada');

    // Source mode edits the whole file, head included.
    await page.getByRole('button', { name: 'Vista en vivo', exact: true }).click();
    await expect(page.locator('.html-source .cm-content')).toContainText('<title>Pagina</title>');
    await page.getByRole('button', { name: 'Código fuente', exact: true }).click();
    await expect(page.locator('.html-content h1')).toHaveText('Portada');

    // Renaming keeps the format and rewrites Markdown links to it.
    await page.getByRole('button', { name: 'Acciones del archivo' }).click();
    await page.getByRole('menuitem', { name: 'Renombrar', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('input').fill('Inicio');
    await dialog.getByRole('button', { name: 'Renombrar', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => content('Diario.md')).toBe('# Diario\n\nVer [[/Inicio.html|la página]]\n');
    expect(await content('Inicio.html')).toContain('<h1>Portada</h1>');

    // Nota.md and Nota.html cannot coexist in one folder.
    await page.getByRole('button', { name: 'Nueva nota', exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await dialog.locator('input').fill('Inicio');
    await dialog.getByRole('radio', { name: /Markdown/ }).click();
    await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(dialog).toContainText('otro formato');
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('HTML notes never run scripts, handlers or remote loads from the file', async () => {
  const hostile = '<!doctype html><html><head><script>window.__fromHead = 1</script></head><body>\n<p onclick="window.__clicked = 1">Texto seguro</p>\n<img src="x" onerror="window.__onerror = 1">\n<script>window.__inline = 1</script>\n<a href="javascript:window.__href = 1">malo</a>\n<form action="https://example.test/steal"><input name="x"></form>\n<iframe src="https://example.test/frame"></iframe>\n</body></html>\n';
  const { app, page, vault } = await launchVault('boveda-html-xss-', { 'Hostil.html': hostile });
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('example.test')) requests.push(request.url()); });
  try {
    await page.getByRole('button', { name: /^Hostil/ }).click();
    const editor = page.locator('.html-content');
    await expect(editor).toContainText('Texto seguro');
    await editor.getByText('Texto seguro').click();
    await editor.getByText('malo').click();
    expect(await page.evaluate(() => [window.__fromHead, window.__clicked, window.__onerror, window.__inline, window.__href])).toEqual([undefined, undefined, undefined, undefined, undefined]);
    await expect(editor.locator('script, iframe, form, [onclick], [onerror]')).toHaveCount(0);
    expect(requests).toEqual([]);
    // Opening without editing never rewrites the file.
    expect(await readFile(path.join(vault, 'Hostil.html'), 'utf8')).toBe(hostile);
  } finally { await app.close(); }
});

test('opening an HTML note never rewrites it, and undoing an edit restores its exact bytes', async () => {
  // Hand-written HTML the editor would normalize: compact markup, a table and a trailing code block.
  const original = '<!DOCTYPE html><html><head><title>Mano</title><style>h1{color:red}</style></head><body><h1>Mano</h1><table><tr><th>A</th><td>1</td></tr></table><ul><li>uno</li></ul><pre><code>fin()</code></pre></body></html>';
  const { app, page, vault } = await launchVault('boveda-html-pristine-', { 'Mano.html': original });
  const content = () => readFile(path.join(vault, 'Mano.html'), 'utf8');
  try {
    await page.getByRole('button', { name: /^Mano/ }).click();
    const editor = page.locator('.html-content');
    await expect(editor.locator('h1')).toHaveText('Mano');
    await editor.locator('h1').click();
    await page.waitForTimeout(900);
    await expect(page.locator('.note-status')).toContainText('Guardado');
    expect(await content()).toBe(original);
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    await expect.poll(content).toContain('<h1>ManoX</h1>');
    // Edits keep the head untouched and only reformat the body.
    expect(await content()).toContain('<head><title>Mano</title><style>h1{color:red}</style></head><body>\n<h1>ManoX</h1>\n');
    await page.keyboard.press('Backspace');
    await expect.poll(content).toBe(original);
    await expect(page.locator('.note-status')).toContainText('Guardado');
  } finally { await app.close(); }
});

declare global { interface Window { __fromHead?: number; __clicked?: number; __onerror?: number; __inline?: number; __href?: number } }
