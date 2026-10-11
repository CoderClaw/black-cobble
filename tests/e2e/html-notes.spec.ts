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

test('editing keeps a tricky head, undo survives mode switches and the format chooser moves focus', async () => {
  // A comment in the head mentions <body>: only the real body may change.
  const head = '<!doctype html><html><head><!-- ejemplo <body> para documentación --><title>Mi título</title></head><body>';
  const original = `${head}<p>Texto</p></body></html>`;
  const { app, page, vault } = await launchVault('boveda-html-modes-', { 'Truco.html': original });
  const content = (name = 'Truco.html') => readFile(path.join(vault, name), 'utf8').catch(() => '');
  try {
    await page.getByRole('button', { name: /^Truco/ }).click();
    const editor = page.locator('.html-content');
    await expect(editor.locator('p')).toHaveText('Texto');
    await expect(editor).not.toContainText('documentación');
    await editor.locator('p').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' editado');
    await expect.poll(() => content()).toBe(`${head}\n<p>Texto editado</p>\n</body></html>`);

    // Visual edit, source and back: undo still reverts it, to the original bytes.
    await page.getByRole('button', { name: 'Vista en vivo', exact: true }).click();
    await expect(page.locator('.html-source .cm-content')).toContainText('Texto editado');
    await page.getByRole('button', { name: 'Código fuente', exact: true }).click();
    await expect(editor).toBeVisible();
    await page.keyboard.press('Control+z');
    await expect.poll(() => content()).toBe(original);

    // Source edit, visual and back: undo reverts it in source mode too.
    await page.getByRole('button', { name: 'Vista en vivo', exact: true }).click();
    const source = page.locator('.html-source .cm-content');
    await expect(source).toBeVisible();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('<!-- fin -->');
    await expect.poll(() => content()).toBe(`${original}<!-- fin -->`);
    await page.getByRole('button', { name: 'Código fuente', exact: true }).click();
    await expect(editor.locator('p')).toHaveText('Texto');
    await page.getByRole('button', { name: 'Vista en vivo', exact: true }).click();
    await expect(source).toBeVisible();
    await page.keyboard.press('Control+z');
    await expect.poll(() => content()).toBe(original);
    await page.getByRole('button', { name: 'Código fuente', exact: true }).click();

    // Arrow keys move focus with the chosen format, so Space keeps it.
    await page.getByRole('button', { name: 'Nueva nota', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input').fill('Formato');
    const markdown = dialog.getByRole('radio', { name: /Markdown/ });
    const html = dialog.getByRole('radio', { name: /HTML/ });
    await markdown.click();
    await page.keyboard.press('ArrowRight');
    await expect(html).toBeFocused();
    await expect(html).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Space');
    await expect(html).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => content('Formato.html')).toContain('<title>Formato</title>');
  } finally { await app.close(); }
});

test('aligns paragraphs and headings one block at a time from the toolbar and shortcuts', async () => {
  const head = '<!doctype html><html><head><title>Alinea</title></head><body>';
  const original = `${head}<p>Base</p></body></html>`;
  const { app, page, vault } = await launchVault('boveda-html-align-', { 'Alinea.html': original, 'Otra.md': '# Otra\n' });
  // The schema keeps an empty paragraph after a trailing heading; it is not what these checks are about.
  const content = async () => (await readFile(path.join(vault, 'Alinea.html'), 'utf8')).replace(/\n<p( style="[^"]*")?><\/p>\n<\/body>/, '\n</body>');
  const aligned = async () => ((await content()).match(/text-align: \w+/g) ?? []).length;
  const button = (name: string) => page.getByRole('toolbar', { name: 'Formato' }).getByRole('button', { name, exact: true });
  const pressed = async (left: string, center: string, right: string) => {
    await expect(button('Alinear a la izquierda')).toHaveAttribute('aria-pressed', left);
    await expect(button('Centrar')).toHaveAttribute('aria-pressed', center);
    await expect(button('Alinear a la derecha')).toHaveAttribute('aria-pressed', right);
  };
  try {
    await page.getByRole('button', { name: /^Alinea/ }).click();
    const editor = page.locator('.html-content');
    await expect(editor.locator('p')).toHaveText('Base');
    await editor.locator('p').click();
    await page.waitForTimeout(300); // let the initial focus settle before moving the caret
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Segundo');
    await page.keyboard.press('Enter');
    await page.keyboard.type('## Titulo');
    await expect(editor.locator('h2')).toHaveText('Titulo');
    await expect.poll(content).toBe(`${head}\n<p>Base</p>\n<p>Segundo</p>\n<h2>Titulo</h2>\n</body></html>`);
    await pressed('true', 'false', 'false');

    // A collapsed cursor aligns only its own block.
    await editor.locator('p', { hasText: 'Segundo' }).click();
    await button('Centrar').click();
    await expect.poll(content).toBe(`${head}\n<p>Base</p>\n<p style="text-align: center;">Segundo</p>\n<h2>Titulo</h2>\n</body></html>`);
    await expect(editor.locator('p', { hasText: 'Segundo' })).toHaveCSS('text-align', 'center');
    await expect(editor.locator('p', { hasText: 'Base' })).toHaveCSS('text-align', 'start');
    await pressed('false', 'true', 'false');
    await editor.locator('h2').click();
    await pressed('true', 'false', 'false');
    await button('Alinear a la derecha').click();
    await expect.poll(content).toContain('<h2 style="text-align: right;">Titulo</h2>');
    expect(await aligned()).toBe(2);

    // A selection aligns every block it touches.
    await page.keyboard.press('Control+a');
    await button('Alinear a la derecha').click();
    await expect.poll(content).toBe(`${head}\n<p style="text-align: right;">Base</p>\n<p style="text-align: right;">Segundo</p>\n<h2 style="text-align: right;">Titulo</h2>\n</body></html>`);
    // Left clears the attribute instead of writing a redundant style.
    await button('Alinear a la izquierda').click();
    await expect.poll(content).toBe(`${head}\n<p>Base</p>\n<p>Segundo</p>\n<h2>Titulo</h2>\n</body></html>`);

    await page.keyboard.press('Control+Home'); // collapses the selection onto the first block
    await editor.locator('p', { hasText: 'Base' }).click();
    await page.keyboard.press('Control+Shift+e');
    await expect.poll(content).toContain('<p style="text-align: center;">Base</p>');
    expect(await aligned()).toBe(1);
    await page.keyboard.press('Control+Shift+r');
    await expect.poll(content).toContain('<p style="text-align: right;">Base</p>');
    await page.keyboard.press('Control+Shift+l');
    await expect.poll(content).toBe(`${head}\n<p>Base</p>\n<p>Segundo</p>\n<h2>Titulo</h2>\n</body></html>`);

    // Reopening shows the saved alignment and does not rewrite the file.
    await editor.locator('p', { hasText: 'Segundo' }).click();
    await button('Centrar').click();
    await expect.poll(aligned).toBe(1);
    await page.waitForTimeout(900);
    await expect(page.locator('.note-status')).toContainText('Guardado');
    const saved = await content();
    await page.getByRole('button', { name: /^Otra/ }).click();
    await expect(page.locator('.cm-content')).toContainText('Otra');
    await page.getByRole('button', { name: /^Alinea/ }).click();
    await expect(editor.locator('p', { hasText: 'Segundo' })).toHaveCSS('text-align', 'center');
    await editor.locator('p', { hasText: 'Segundo' }).click();
    await pressed('false', 'true', 'false');
    await editor.locator('p', { hasText: 'Base' }).click();
    await pressed('true', 'false', 'false');
    await page.waitForTimeout(900);
    expect(await content()).toBe(saved);
  } finally { await app.close(); }
});

test('existing text alignment loads, renders and round-trips, including inside lists and tables', async () => {
  const original = '<!DOCTYPE html><html><head><title>Estilos</title></head><body><h1 style="text-align: center">T</h1><p style="text-align: right">R</p><p style="text-align: left">L</p><p>N</p><ul><li><p>item</p></li></ul><table><tr><td><p>celda</p></td></tr></table></body></html>';
  const { app, page, vault } = await launchVault('boveda-html-align-load-', { 'Estilos.html': original });
  const content = () => readFile(path.join(vault, 'Estilos.html'), 'utf8');
  try {
    await page.getByRole('button', { name: /^Estilos/ }).click();
    const editor = page.locator('.html-content');
    await expect(editor.locator('h1')).toHaveCSS('text-align', 'center');
    await expect(editor.locator('p', { hasText: /^R$/ })).toHaveCSS('text-align', 'right');
    await expect(editor.locator('p', { hasText: /^N$/ })).toHaveCSS('text-align', 'start');
    await editor.locator('h1').click();
    await page.waitForTimeout(900);
    await expect(page.locator('.note-status')).toContainText('Guardado');
    expect(await content()).toBe(original);

    // An explicit left in the file survives until the user changes it.
    await editor.locator('p', { hasText: /^N$/ }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    await expect.poll(content).toContain('<h1 style="text-align: center;">T</h1>\n<p style="text-align: right;">R</p>\n<p style="text-align: left;">L</p>\n<p>NX</p>');
    await page.keyboard.press('Control+z');
    await expect.poll(content).toBe(original);

    // Paragraphs inside list items and table cells are aligned too.
    await page.keyboard.press('Control+a');
    await page.getByRole('toolbar', { name: 'Formato' }).getByRole('button', { name: 'Centrar', exact: true }).click();
    await expect.poll(content).toContain('<li><p style="text-align: center;">item</p>');
    const saved = await content();
    expect(saved).toContain('<p style="text-align: center;">celda</p>');
    expect(saved.match(/text-align: center/g)).toHaveLength(7); // includes the empty paragraph the schema appends after the table
    expect(saved).not.toMatch(/text-align: (left|right)/);
  } finally { await app.close(); }
});

declare global { interface Window { __fromHead?: number; __clicked?: number; __onerror?: number; __inline?: number; __href?: number } }
