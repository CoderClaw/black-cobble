import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function launchVault(prefix: string, notes: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const vault = path.join(root, 'vault');
  for (const [name, content] of Object.entries(notes)) {
    await mkdir(path.dirname(path.join(vault, name)), { recursive: true });
    await writeFile(path.join(vault, name), content);
  }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  return { app, vault, page: await app.firstWindow() };
}

test('searches and replaces across Markdown and HTML notes', async () => {
  const html = '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<title>Pagina</title>\n</head>\n<body>\n<p class="gato">El <strong>gato</strong> duerme.</p>\n</body>\n</html>\n';
  const { app, page, vault } = await launchVault('boveda-search-', {
    'Alfa.md': '# Alfa\n\nEl gato come. Gato grande.\ngatos y gato.\n',
    'Proyectos/Beta.md': 'Un gato en el proyecto.\n',
    'Gamma.md': 'Sin coincidencias aquí.\n',
    'Pagina.html': html,
  });
  const content = (name: string) => readFile(path.join(vault, name), 'utf8');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Gamma', exact: true })).toBeVisible();
    const panel = page.getByRole('complementary', { name: 'Buscar en notas' });
    await expect(panel).toBeHidden();
    await page.keyboard.press('Control+Shift+F');
    await expect(panel).toBeVisible();
    const search = panel.getByRole('textbox', { name: 'Buscar', exact: true });
    await expect(search).toBeFocused();
    const summary = panel.locator('.search-summary');

    await search.fill('gato');
    await expect(summary).toHaveText('6 resultados en 3 archivos');
    await expect(panel.locator('.search-file-row')).toHaveCount(3);
    await expect(panel.locator('mark').first()).toHaveText(/gato/i);

    const matchCase = panel.getByRole('button', { name: 'Coincidir mayúsculas y minúsculas' });
    await matchCase.click();
    await expect(matchCase).toHaveAttribute('aria-pressed', 'true');
    await expect(summary).toHaveText('5 resultados en 3 archivos');
    await search.press('Alt+w');
    await expect(panel.getByRole('button', { name: 'Solo palabras completas' })).toHaveAttribute('aria-pressed', 'true');
    await expect(summary).toHaveText('4 resultados en 3 archivos');
    await search.press('Alt+w');
    await panel.getByRole('button', { name: 'Usar expresión regular' }).click();
    await search.fill('G\\w+o');
    await expect(summary).toHaveText('1 resultado en 1 archivo');
    await search.fill('gato(');
    await expect(panel.locator('.search-error')).toContainText('Expresión regular no válida');
    await expect(summary).toHaveText('');
    await panel.getByRole('button', { name: 'Usar expresión regular' }).click();
    await matchCase.click();
    await search.fill('gato');
    await expect(summary).toHaveText('6 resultados en 3 archivos');
    await expect(panel.locator('.search-error')).toHaveText('');

    await panel.getByRole('button', { name: 'Alternar detalles de búsqueda' }).click();
    const include = panel.getByLabel('Archivos para incluir');
    await include.fill('*.html');
    await expect(summary).toHaveText('1 resultado en 1 archivo');
    await include.fill('');
    await expect(summary).toHaveText('6 resultados en 3 archivos');

    // Opening a match selects it in the editor, Markdown and visual HTML alike.
    await panel.locator('.search-match-row', { hasText: 'proyecto' }).getByRole('button').first().click();
    await expect(page.locator('.note-path')).toContainText('Beta');
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('gato');
    await search.press('Escape');
    await expect(page.locator('.cm-content')).toBeFocused();
    await panel.locator('.search-match-row', { hasText: 'duerme' }).getByRole('button').first().click();
    await expect(page.locator('.html-content strong')).toHaveText('gato');
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('gato');

    await page.keyboard.press('Control+Shift+H');
    const replace = panel.getByRole('textbox', { name: 'Reemplazar', exact: true });
    await expect(replace).toBeFocused();
    await expect(panel.getByRole('button', { name: 'Alternar reemplazo' })).toHaveAttribute('aria-expanded', 'true');
    await replace.fill('perro');
    await expect(panel.locator('.search-replace-new').first()).toHaveText('perro');

    const betaRow = panel.locator('.search-match-row', { hasText: 'proyecto' });
    await betaRow.hover();
    await betaRow.getByRole('button', { name: 'Reemplazar', exact: true }).click();
    await expect.poll(() => content('Proyectos/Beta.md')).toBe('Un perro en el proyecto.\n');
    await expect(summary).toHaveText('5 resultados en 2 archivos');

    await panel.getByRole('button', { name: 'Reemplazar todo', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('¿Reemplazar 5 coincidencias en 2 archivos por «perro»?');
    await dialog.getByRole('button', { name: 'Reemplazar', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole('status')).toContainText('Se reemplazaron 5 coincidencias en 2 archivos');
    await expect(summary).toHaveText('Sin resultados.');
    expect(await content('Alfa.md')).toBe('# Alfa\n\nEl perro come. perro grande.\nperros y perro.\n');
    expect(await content('Pagina.html')).toBe(html.replace('<strong>gato</strong>', '<strong>perro</strong>'));
    expect(await content('Gamma.md')).toBe('Sin coincidencias aquí.\n');
    // The open note reloads from disk.
    await expect(page.locator('.html-content strong')).toHaveText('perro');

    await panel.getByRole('button', { name: 'Cerrar búsqueda' }).click();
    await expect(panel).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('locking the private vault clears the search panel', async () => {
  const { app, page } = await launchVault('boveda-search-private-', { 'Publica.md': 'Nada privado.\n' });
  const password = 'Synthetic search password 40112';
  const secret = 'Secreto buscable 77310';
  try {
    await page.getByRole('button', { name: 'Privada', exact: true }).click();
    await page.getByRole('button', { name: 'Crear contraseña', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Contraseña', { exact: true }).fill(password);
    await dialog.getByLabel('Confirmar contraseña', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: 'Crear contraseña', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Nueva nota', exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await dialog.locator('input').fill('Privada');
    await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.insertText(`${secret}\n`);

    await page.getByRole('button', { name: 'Buscar en notas', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Buscar en notas' });
    const search = panel.getByRole('textbox', { name: 'Buscar', exact: true });
    await expect(search).toBeFocused();
    await search.fill('Secreto');
    await expect(panel.locator('.search-summary')).toHaveText('1 resultado en 1 archivo');
    await expect(panel).toContainText(secret);

    await page.evaluate(() => window.vault.lockPrivateSession());
    await expect(panel).toContainText('Desbloquea la bóveda privada');
    await expect(page.locator('body')).not.toContainText(secret);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('Secreto');

    await page.getByRole('button', { name: 'Desbloquear bóveda', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Contraseña', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: 'Desbloquear bóveda', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(panel.locator('.search-match-row')).toHaveCount(0);

    // Locking while the replace-all confirmation is open removes the dialog and every result.
    await search.fill('Secreto');
    await expect(panel.locator('.search-summary')).toHaveText('1 resultado en 1 archivo');
    await page.keyboard.press('Control+Shift+H');
    await panel.getByRole('textbox', { name: 'Reemplazar', exact: true }).fill('Otro');
    await panel.getByRole('button', { name: 'Reemplazar todo', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('¿Reemplazar 1 coincidencia en 1 archivo por «Otro»?');
    await page.evaluate(() => window.vault.lockPrivateSession());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(secret);
    await expect(panel).toContainText('Desbloquea la bóveda privada');
  } finally { await app.close(); }
});

test('replacing honours dismissals and the current options, and CRLF matches are revealed exactly', async () => {
  const { app, page, vault } = await launchVault('boveda-search-dismiss-', {
    'Uno.md': 'gato gato gato\nGato final\n',
    'Dos.md': 'otro gato\n',
    'Crlf.md': 'linea uno\r\nlinea dos\r\nel gato aqui\r\n',
  });
  const content = (name: string) => readFile(path.join(vault, name), 'utf8');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Uno', exact: true })).toBeVisible();
    await page.keyboard.press('Control+Shift+H');
    const panel = page.getByRole('complementary', { name: 'Buscar en notas' });
    const search = panel.getByRole('textbox', { name: 'Buscar', exact: true });
    const summary = panel.locator('.search-summary');
    await search.fill('gato');
    await expect(summary).toHaveText('6 resultados en 3 archivos');

    // Raw offsets after "\r\n" are converted to editor offsets, and opening never rewrites the line endings.
    await panel.locator('.search-match-row', { hasText: 'aqui' }).getByRole('button').first().click();
    await expect(page.locator('.note-path')).toContainText('Crlf');
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('gato');
    await page.waitForTimeout(700);
    expect(await content('Crlf.md')).toBe('linea uno\r\nlinea dos\r\nel gato aqui\r\n');

    // Toggling an option disables replacing until results for the new options arrive.
    await panel.getByRole('textbox', { name: 'Reemplazar', exact: true }).fill('perro');
    await search.press('Alt+c');
    await expect(panel.getByRole('button', { name: 'Coincidir mayúsculas y minúsculas' })).toHaveAttribute('aria-pressed', 'true');
    await panel.getByRole('button', { name: 'Reemplazar todo', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('¿Reemplazar 5 coincidencias en 3 archivos por «perro»?');
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // A dismissed match survives rescans after disk changes and is left alone by "replace in file".
    const unoMatches = panel.locator('li', { has: page.locator('.search-file-row', { hasText: 'Uno.md' }) }).locator('.search-match-row');
    await expect(unoMatches).toHaveCount(3);
    await unoMatches.nth(1).hover();
    await unoMatches.nth(1).getByRole('button', { name: 'Descartar', exact: true }).click();
    await expect(summary).toHaveText('4 resultados en 3 archivos');
    await writeFile(path.join(vault, 'Dos.md'), 'otro gato más\n');
    await expect(panel.locator('.search-match-row', { hasText: 'más' })).toHaveCount(1);
    await expect(unoMatches).toHaveCount(2);
    const unoRow = panel.locator('.search-file-row', { hasText: 'Uno.md' });
    await unoRow.hover();
    await unoRow.getByRole('button', { name: 'Reemplazar todo en el archivo', exact: true }).click();
    await expect.poll(() => content('Uno.md')).toBe('perro gato perro\nGato final\n');
    await expect(summary).toHaveText('2 resultados en 2 archivos');
    await expect(panel.locator('.search-file-row', { hasText: 'Uno.md' })).toHaveCount(0);
    expect(await content('Dos.md')).toBe('otro gato más\n');
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('dismissals follow exact rewrites, CRLF notes stay CRLF and visual HTML reveals the real match', async () => {
  const { app, page, vault } = await launchVault('boveda-search-edits-', {
    'Uno.md': 'uno gato\ndos gato\ntres gato\n',
    'Crlf.md': 'uno gato\r\ndos gato\r\n',
    'Web.html': '<!doctype html>\n<html>\n<body>\n<p>gatos y gato</p>\n</body>\n</html>\n',
  });
  const content = (name: string) => readFile(path.join(vault, name), 'utf8');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Uno', exact: true })).toBeVisible();
    await page.keyboard.press('Control+Shift+H');
    const panel = page.getByRole('complementary', { name: 'Buscar en notas' });
    const search = panel.getByRole('textbox', { name: 'Buscar', exact: true });
    const summary = panel.locator('.search-summary');
    const status = panel.getByRole('status');
    const row = (text: string) => panel.locator('.search-match-row', { hasText: text });
    const fileItem = (name: string) => panel.locator('li', { has: page.locator('.search-file-row', { hasText: name }) });
    async function replaceRow(name: string, text: string) {
      await expect(panel.getByRole('button', { name: 'Reemplazar todo', exact: true })).toBeEnabled();
      const target = fileItem(name).locator('.search-match-row', { hasText: text });
      await target.hover();
      await target.getByRole('button', { name: 'Reemplazar', exact: true }).click();
    }
    await search.fill('gato');
    await panel.getByRole('textbox', { name: 'Reemplazar', exact: true }).fill('gatos');
    await expect(summary).toHaveText('7 resultados en 3 archivos');

    // The replacement contains the query: the dismissed match must stay hidden and untouched.
    const unoFile = fileItem('Uno.md');
    await unoFile.locator('.search-match-row', { hasText: 'dos' }).hover();
    await unoFile.locator('.search-match-row', { hasText: 'dos' }).getByRole('button', { name: 'Descartar', exact: true }).click();
    await expect(summary).toHaveText('6 resultados en 3 archivos');
    await replaceRow('Uno.md', 'tres');
    await expect.poll(() => content('Uno.md')).toBe('uno gato\ndos gato\ntres gatos\n');
    await expect(summary).toHaveText('6 resultados en 3 archivos');
    await expect(unoFile.locator('.search-match-row', { hasText: 'dos' })).toHaveCount(0);
    await unoFile.locator('.search-file-row').hover();
    await unoFile.getByRole('button', { name: 'Reemplazar todo en el archivo', exact: true }).click();
    await expect.poll(() => content('Uno.md')).toBe('uno gatos\ndos gato\ntres gatoss\n');
    await expect(unoFile.locator('.search-match-row', { hasText: 'dos' })).toHaveCount(0);

    // Replacing twice in an open CRLF note: the reload is not an edit and the file keeps CRLF.
    await panel.getByRole('textbox', { name: 'Reemplazar', exact: true }).fill('perro');
    await fileItem('Crlf.md').locator('.search-match-row', { hasText: 'dos' }).getByRole('button').first().click();
    await expect(page.locator('.note-path')).toContainText('Crlf');
    await replaceRow('Crlf.md', 'uno');
    await expect.poll(() => content('Crlf.md')).toBe('uno perro\r\ndos gato\r\n');
    await expect(status).toContainText('Se reemplazó 1 coincidencia en 1 archivo.');
    await page.waitForTimeout(700);
    await expect(page.locator('.note-status')).toContainText('Guardado');
    expect(await content('Crlf.md')).toBe('uno perro\r\ndos gato\r\n');
    await replaceRow('Crlf.md', 'dos');
    await expect.poll(() => content('Crlf.md')).toBe('uno perro\r\ndos perro\r\n');
    await expect(status).toHaveText('Se reemplazó 1 coincidencia en 1 archivo.');
    await expect(page.locator('.cm-content')).toContainText('dos perro');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('fin');
    await expect.poll(() => content('Crlf.md')).toBe('uno perro\r\ndos perro\r\nfin');

    // Whole word: the visual editor selects the real match, not "gato" inside "gatos".
    await panel.getByRole('button', { name: 'Solo palabras completas' }).click();
    await expect(row('gatos y')).toHaveCount(1);
    await row('gatos y').getByRole('button').first().click();
    await expect(page.locator('.html-content')).toContainText('gatos y gato');
    await expect.poll(() => page.evaluate(() => {
      const selection = window.getSelection();
      return selection?.anchorNode ? `${selection.toString()}@${Math.min(selection.anchorOffset, selection.focusOffset)}` : '';
    })).toBe('gato@8');
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
