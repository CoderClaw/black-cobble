import { test, expect, _electron as electron } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const electronBinary = createRequire(path.resolve('package.json'))('electron') as string;
type TestMain = typeof globalThis & { secondInstances?: number };

async function profile() {
  const root = await mkdtemp(path.join(tmpdir(), 'black-cobble-single-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  await writeFile(path.join(vault, 'Nota.md'), '# Nota\n');
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return { vault, env };
}

/** Starts the app again with the same profile, outside Playwright, and resolves with its exit code. */
function launchAgain(env: Record<string, string>): Promise<number | null> {
  const second = spawn(electronBinary, [path.resolve('dist-electron/main.cjs')], { env, stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { second.kill(); reject(new Error('The second instance kept running.')); }, 20_000);
    second.once('error', reject);
    second.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

// Two processes on one private vault could both confirm a save and lose one of them (GS04): a second launch with
// the same profile must exit and hand over to the running window instead of opening the vault again.
test('a second launch with the same profile exits and hands over to the running window', async () => {
  const { vault, env } = await profile();
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Nota', exact: true })).toBeVisible();
    await app.evaluate(({ app: main }) => { main.on('second-instance', () => { const state = globalThis as TestMain; state.secondInstances = (state.secondInstances ?? 0) + 1; }); });

    expect(await launchAgain(env)).toBe(0);
    await expect.poll(() => app.evaluate(() => (globalThis as TestMain).secondInstances ?? 0)).toBe(1);
    expect(app.windows()).toHaveLength(1);

    // The running instance keeps working on the vault as before.
    await page.getByRole('button', { name: 'Nota', exact: true }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\nSigue funcionando');
    await expect.poll(() => readFile(path.join(vault, 'Nota.md'), 'utf8')).toContain('Sigue funcionando');
  } finally { await app.close(); }
});

// On macOS closing the window keeps the process (and its lock): launching again must bring a window back.
test('a second launch reopens the window when the running instance has none', async () => {
  const { env } = await profile();
  const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Nota', exact: true })).toBeVisible();
    // Reproduce macOS on any platform: closing the last window does not quit the app.
    await app.evaluate(({ app: main, BrowserWindow }) => {
      main.removeAllListeners('window-all-closed');
      main.on('window-all-closed', () => undefined);
      BrowserWindow.getAllWindows()[0].destroy();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    const reopened = app.waitForEvent('window');
    expect(await launchAgain(env)).toBe(0);
    const next = await reopened;
    await expect(next.getByRole('button', { name: 'Nota', exact: true })).toBeVisible();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    // Quit again once the windows close, so the app can shut down.
    await app.evaluate(({ app: main }) => { main.removeAllListeners('window-all-closed'); main.on('window-all-closed', () => main.quit()); }).catch(() => undefined);
    await app.close();
  }
});
