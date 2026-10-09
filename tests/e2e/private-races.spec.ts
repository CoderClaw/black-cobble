import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const PASSWORD = 'Synthetic race password 73481';
const ORIGINAL = '# Synthetic note\n\nOriginal public text\n';
type InvokeHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type TestMain = typeof globalThis & { privateRaceGate?: { entered: boolean; release: () => void }; privateRaceAck?: boolean; privateRaceDraftAck?: boolean };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'black-cobble-vault-races-'));
  const vault = path.join(root, 'vault'); await mkdir(vault);
  await writeFile(path.join(vault, 'Note.md'), ORIGINAL);
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await electron.launch({ args: [path.resolve('dist-electron/main.cjs')], env });
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Note', exact: true })).toBeVisible();
    return { app, page };
  };
  return { vault, launch, ...await launch() };
}
async function openNote(page: Page) {
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Synthetic note');
}
async function setupPrivate(page: Page) {
  await page.getByRole('button', { name: 'Privada', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.vault.getVault().then(v => v?.kind))).toBe('private');
  await page.evaluate(async ({ password, text }) => {
    const session = await window.vault.setupPrivateSession(password);
    await window.vault.createPrivateCopy('', 'Note', text, session.sessionId!);
  }, { password: PASSWORD, text: '# Synthetic note\n\nPrivate original\n' });
  await openNote(page);
}
async function holdNextWrite(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, InvokeHandler> })._invokeHandlers;
    const original = handlers.get('vault:write');
    if (!original) throw new Error('Missing write IPC handler');
    const state = globalThis as TestMain;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    state.privateRaceGate = { entered: false, release };
    ipcMain.removeHandler('vault:write');
    ipcMain.handle('vault:write', async (event, ...args: unknown[]) => {
      const current = state.privateRaceGate!;
      if (!current.entered) { current.entered = true; await gate; }
      return original(event, ...args);
    });
  });
}

test('switching vault saves private edits, clears private UI, and never changes a public namesake', async () => {
  const { app, page, vault } = await fixture();
  try {
    await setupPrivate(page);
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+End');
    await page.keyboard.insertText('Private switch token 86217');
    await page.getByRole('button', { name: 'Normal', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.vault.getVault().then(v => v?.kind))).toBe('normal');
    await expect(page.locator('body')).not.toContainText('Private switch token');
    expect(await readFile(path.join(vault, 'Note.md'), 'utf8')).toBe(ORIGINAL);
    await page.getByRole('button', { name: 'Privada', exact: true }).click();
    const content = await page.evaluate(async password => {
      await window.vault.unlockPrivateSession(password);
      return (await window.vault.readNote('Note.md')).content;
    }, PASSWORD);
    expect(content).toContain('Private switch token 86217');
  } finally { await app.close(); }
});

test('native close saves a dirty public note with an in-flight write', async () => {
  const { app, page, vault } = await fixture(); let closed = false;
  try {
    await openNote(page); await holdNextWrite(app);
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+End');
    await page.keyboard.insertText('Synthetic public close 49321');
    await expect.poll(() => app.evaluate(() => (globalThis as TestMain).privateRaceGate?.entered)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const closing = app.waitForEvent('close');
    await app.evaluate(() => (globalThis as TestMain).privateRaceGate!.release());
    await closing; closed = true;
    expect(await readFile(path.join(vault, 'Note.md'), 'utf8')).toContain('Synthetic public close 49321');
  } finally { if (!closed) { await app.evaluate(() => (globalThis as TestMain).privateRaceGate?.release()).catch(() => {}); await app.close(); } }
});

test('native close purges private DOM before acknowledgment and preserves accepted draft', async () => {
  const f = await fixture(); let app: ElectronApplication | undefined = f.app;
  try {
    await setupPrivate(f.page); await holdNextWrite(app);
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, InvokeHandler> })._invokeHandlers;
      const snapshot = handlers.get('private:draft');
      if (!snapshot) throw new Error('Missing draft handler');
      ipcMain.removeHandler('private:draft');
      ipcMain.handle('private:draft', async (event, ...args: unknown[]) => {
        const result = await snapshot(event, ...args); (globalThis as TestMain).privateRaceDraftAck = true; return result;
      });
      ipcMain.on('private:lock-ack', event => {
        void event.sender.executeJavaScript("document.querySelector('.cm-editor') === null && !document.body.textContent.includes('Synthetic private close 21649')")
          .then((cleared: boolean) => { (globalThis as TestMain).privateRaceAck = cleared; });
      });
    });
    await f.page.locator('.cm-content').click(); await f.page.keyboard.press('Control+End');
    await f.page.keyboard.insertText('Synthetic private close 21649');
    await expect.poll(() => app!.evaluate(() => (globalThis as TestMain).privateRaceDraftAck)).toBe(true);
    await expect.poll(() => app!.evaluate(() => (globalThis as TestMain).privateRaceGate?.entered)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app!.evaluate(() => (globalThis as TestMain).privateRaceAck)).toBe(true);
    const closing = app.waitForEvent('close');
    await app.evaluate(() => (globalThis as TestMain).privateRaceGate!.release());
    await closing; app = undefined;
    expect(await readFile(path.join(f.vault, 'Note.md'), 'utf8')).toBe(ORIGINAL);
    const next = await f.launch(); app = next.app;
    await next.page.getByRole('button', { name: 'Privada', exact: true }).click();
    const saved = await next.page.evaluate(async password => {
      const session = await window.vault.unlockPrivateSession(password);
      const note = await window.vault.readNote('Note.md');
      const drafts = await window.vault.listPrivateDrafts(session.sessionId!);
      const recovered = drafts.length ? await window.vault.recoverPrivateDraft(drafts[0].id, session.sessionId!) : null;
      return `${note.content}\n${recovered?.content ?? ''}`;
    }, PASSWORD);
    expect(saved).toContain('Synthetic private close 21649');
  } finally { if (app) { await app.evaluate(() => (globalThis as TestMain).privateRaceGate?.release()).catch(() => {}); await app.close(); } }
});
