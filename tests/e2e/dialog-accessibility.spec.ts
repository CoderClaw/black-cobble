import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function launch(notes: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'black-cobble-dialog-a11y-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  for (const [name, content] of Object.entries(notes)) await writeFile(path.join(vault, name), content);
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  return { app, vault, page: await app.firstWindow() };
}

/** Is the focused element inside the (single) open modal dialog? */
const focusInside = (page: Page) => page.evaluate(() => {
  const dialog = document.querySelector('dialog[open]');
  return !!dialog && !!document.activeElement && dialog.contains(document.activeElement);
});
/** Describes the focused element so failures and reports are readable. */
const focusDescription = (page: Page) => page.evaluate(() => {
  const element = document.activeElement;
  if (!element || element === document.body) return 'body';
  const label = element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '';
  return `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(' ')[0]}` : ''}[${label}]`;
});

/** Tab and Shift+Tab around the whole dialog twice: focus must never leave it, and every focusable control must be reached. */
async function expectFocusTrapped(page: Page, dialog: Locator) {
  const focusable = await dialog.locator('input, select, button, [href], textarea, [tabindex]:not([tabindex="-1"])').evaluateAll(
    elements => elements.filter(element => !(element as HTMLButtonElement).disabled && element.getClientRects().length > 0).length);
  expect(focusable).toBeGreaterThan(0);
  const visited = new Set<string>();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let step = 0; step < focusable * 2 + 1; step++) {
      await page.keyboard.press(key);
      expect(await focusInside(page), `${key} step ${step + 1} left the dialog (focus on ${await focusDescription(page)})`).toBe(true);
      visited.add(await focusDescription(page));
    }
  }
  // Every tab stop in the dialog is reachable by keyboard (radio groups expose one stop).
  expect(visited.size).toBeGreaterThanOrEqual(Math.min(focusable, 2));
}

/** Escape closes the modal. Returns a description of whatever holds focus afterwards. */
async function escapeAndClose(page: Page, dialog: Locator) {
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  return focusDescription(page);
}

interface Opened { dialog: Locator; /** Control that should get focus back when the dialog closes. */ restoreTo: Locator }
interface Scenario { name: string; notes: Record<string, string>; open: (page: Page) => Promise<Opened> }

const NOTE = { 'Nota.md': '# Nota\n' };
const scenarios: Record<string, Scenario> = {
  newNote: {
    name: 'EntryDialog (Nueva nota)', notes: NOTE,
    async open(page) {
      await expect(page.getByRole('button', { name: 'Nota', exact: true })).toBeVisible();
      const opener = page.locator('.sidebar-tools').getByRole('button', { name: 'Nueva nota', exact: true });
      await opener.click();
      return { dialog: page.getByRole('dialog', { name: 'Nueva nota' }), restoreTo: opener };
    },
  },
  rename: {
    name: 'EntryDialog (Renombrar)', notes: NOTE,
    async open(page) {
      const note = page.getByRole('button', { name: 'Nota', exact: true });
      await note.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Renombrar' }).click();
      return { dialog: page.getByRole('dialog', { name: 'Renombrar' }), restoreTo: note };
    },
  },
  trash: {
    name: 'EntryDialog (Enviar a la papelera)', notes: NOTE,
    async open(page) {
      const note = page.getByRole('button', { name: 'Nota', exact: true });
      await note.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Papelera' }).click();
      return { dialog: page.getByRole('dialog', { name: 'Enviar a la papelera' }), restoreTo: note };
    },
  },
  password: {
    name: 'PrivatePasswordDialog (setup)', notes: { 'Publica.md': '# Publica\n' },
    async open(page) {
      await expect(page.getByRole('button', { name: 'Publica', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Privada', exact: true }).click();
      const opener = page.getByRole('button', { name: 'Crear contraseña', exact: true }).first();
      await opener.click();
      return { dialog: page.getByRole('dialog', { name: 'Crear contraseña' }), restoreTo: opener };
    },
  },
  replaceAll: {
    name: 'ConfirmReplace (Reemplazar todo)', notes: { 'Alfa.md': '# Alfa\n\nEl gato come.\n', 'Beta.md': 'Otro gato.\n' },
    async open(page) {
      await expect(page.getByRole('button', { name: 'Beta', exact: true })).toBeVisible();
      const panel = page.getByRole('complementary', { name: 'Buscar en notas' });
      await page.keyboard.press('Control+Shift+H');
      await expect(panel).toBeVisible();
      await panel.getByRole('textbox', { name: 'Buscar', exact: true }).fill('gato');
      await expect(panel.locator('.search-summary')).toHaveText('2 resultados en 2 archivos');
      await panel.getByRole('textbox', { name: 'Reemplazar', exact: true }).fill('perro');
      const opener = panel.getByRole('button', { name: 'Reemplazar todo', exact: true });
      await expect(opener).toBeEnabled();
      await opener.click();
      return { dialog: page.getByRole('dialog', { name: 'Reemplazar todo' }), restoreTo: opener };
    },
  },
};

/** Opens a scenario in a fresh app and hands it to `check`, always closing the app afterwards. */
async function withScenario(scenario: Scenario, check: (page: Page, opened: Opened) => Promise<void>) {
  const { app, page } = await launch(scenario.notes);
  try {
    const opened = await scenario.open(page);
    await expect(opened.dialog).toBeVisible();
    await check(page, opened);
  } finally { await app.close(); }
}

test.describe('accessible name, description, initial focus and keyboard trap', () => {
  test('EntryDialog: new note', async () => {
    await withScenario(scenarios.newNote, async (page, { dialog }) => {
      await expect(dialog.getByRole('heading', { name: 'Nueva nota' })).toBeVisible();
      // A creation dialog has no description.
      await expect(dialog).not.toHaveAttribute('aria-describedby', /.+/);
      await expect(dialog.getByRole('textbox', { name: 'Nombre' })).toBeFocused();
      await expect(dialog.getByRole('radiogroup', { name: 'Formato' })).toBeVisible();
      await expectFocusTrapped(page, dialog);
      await escapeAndClose(page, dialog);
    });
  });

  test('EntryDialog: rename', async () => {
    await withScenario(scenarios.rename, async (page, { dialog }) => {
      const input = dialog.getByRole('textbox', { name: 'Nombre' });
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('Nota');
      await expectFocusTrapped(page, dialog);
      await escapeAndClose(page, dialog);
    });
  });

  test('EntryDialog: trash confirmation is described by its message', async () => {
    await withScenario(scenarios.trash, async (page, { dialog }) => {
      const message = 'Se enviará "Nota.md" a la papelera.';
      await expect(dialog).toHaveAccessibleDescription(message);
      // aria-describedby really points at the visible paragraph.
      const describedBy = await dialog.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(message);
      // There is no input: focus lands on the first control, the safe Cancelar button.
      await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
      await expectFocusTrapped(page, dialog);
      await escapeAndClose(page, dialog);
    });
  });

  test('PrivatePasswordDialog (setup)', async () => {
    await withScenario(scenarios.password, async (page, { dialog }) => {
      const message = 'Esta contraseña abre la bóveda privada. No se puede recuperar si la olvidas.';
      await expect(dialog).toHaveAccessibleDescription(message);
      const describedBy = await dialog.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(message);
      await expect(dialog.getByLabel('Contraseña', { exact: true })).toBeFocused();
      await expectFocusTrapped(page, dialog);
      await escapeAndClose(page, dialog);
    });
  });

  test('ConfirmReplace (Reemplazar todo)', async () => {
    await withScenario(scenarios.replaceAll, async (page, { dialog }) => {
      const message = '¿Reemplazar 2 coincidencias en 2 archivos por «perro»?';
      await expect(dialog).toHaveAccessibleDescription(message);
      const describedBy = await dialog.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(message);
      // A bulk change starts on the safe choice.
      await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
      await expectFocusTrapped(page, dialog);
      await escapeAndClose(page, dialog);
    });
  });
});

// Dialogs are unmounted by React instead of being close()d, so the app itself must give focus back to the control
// that opened them (for context menu items, the tree row the menu was opened on).
test.describe('focus restoration after Escape', () => {
  for (const [key, scenario] of Object.entries(scenarios)) {
    test(`${scenario.name} returns focus to its opener`, async () => {
      await withScenario(scenarios[key], async (page, { dialog, restoreTo }) => {
        const where = await escapeAndClose(page, dialog);
        expect(where, 'focus must not be lost to <body> after the dialog closes').not.toBe('body');
        await expect(restoreTo).toBeFocused();
      });
    });
  }
});

// After Escape nothing modal remains and the page is interactive again from the keyboard (Tab reaches a real control).
test('after Escape the page is usable again by keyboard', async () => {
  await withScenario(scenarios.rename, async (page, { dialog }) => {
    await escapeAndClose(page, dialog);
    await page.keyboard.press('Tab');
    expect(await focusDescription(page)).not.toBe('body');
    expect(await page.evaluate(() => document.activeElement?.closest('dialog'))).toBeNull();
  });
});

test('confirming Reemplazar todo keeps focus in the search panel while its opener is disabled', async () => {
  await withScenario(scenarios.replaceAll, async (page, { dialog }) => {
    const panel = page.getByRole('complementary', { name: 'Buscar en notas' });
    await dialog.getByRole('button', { name: 'Reemplazar', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole('status')).toContainText('Se reemplazaron 2 coincidencias');
    await expect(panel.getByRole('textbox', { name: 'Reemplazar', exact: true })).toBeFocused();
  });
});

// React's StrictMode runs effects twice in development: the dialog must still give focus back to its opener.
test('development build (StrictMode) also returns focus to the opener', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ server: { port: 5173 } });
  await server.listen();
  const root = await mkdtemp(path.join(tmpdir(), 'black-cobble-dialog-dev-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  await writeFile(path.join(vault, 'Nota.md'), '# Nota\n');
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile'), VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Nota', exact: true })).toBeVisible();
    const opener = page.locator('.sidebar-tools').getByRole('button', { name: 'Nueva nota', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Nueva nota' });
    await expect(dialog.getByRole('textbox', { name: 'Nombre' })).toBeFocused();
    await escapeAndClose(page, dialog);
    await expect(opener).toBeFocused();
  } finally {
    await app.close();
    await server.close();
  }
});
