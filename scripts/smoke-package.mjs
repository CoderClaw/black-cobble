import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const defaults = { win32: 'release/win-unpacked/Black Cobble.exe', linux: 'release/linux-unpacked/black-cobble' };
const requested = process.env.BOVEDA_PACKAGED_EXE || process.argv[2] || defaults[process.platform];
if (!requested) {
  console.error(`Plataforma no admitida: ${process.platform}. Indica el ejecutable con BOVEDA_PACKAGED_EXE o como argumento.`);
  process.exit(1);
}
const executablePath = path.resolve(requested);
if (!existsSync(executablePath)) {
  console.error(`No se encuentra el ejecutable empaquetado: ${executablePath}\nGenéralo antes con "npm run package".`);
  process.exit(1);
}

const root = await mkdtemp(path.join(tmpdir(), 'boveda-package-'));
const vault = path.join(root, 'vault');
await mkdir(vault);
await mkdir(path.join(vault, 'programacion'));
await writeFile(path.join(vault, 'programacion', 'js.md'), '# JavaScript\n');
await writeFile(path.join(vault, 'Prueba.md'), '# Aplicación empaquetada\n\n[[programacion/js]]\n\n');
const env = { ...process.env, BOVEDA_TEST_VAULT: vault, BOVEDA_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath, env });
try {
  const page = await app.firstWindow();
  assert.equal(await page.title(), 'Black Cobble');
  assert.equal(await app.evaluate(({ app }) => app.getName()), 'Black Cobble');
  await page.getByRole('button', { name: 'Prueba', exact: true }).click();
  const link = page.locator('[data-wiki-target="programacion/js"]');
  await link.waitFor();
  assert.equal(await link.textContent(), 'js');
  await page.locator('[data-entry-path="Prueba.md"][draggable="true"]').waitFor();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('Guardado desde el ejecutable.');
  await page.getByRole('button', { name: 'Privada', exact: true }).click();
  await page.waitForFunction(async () => (await window.vault.getVault())?.kind === 'private');
  const privateResult = await page.evaluate(async () => {
    const session = await window.vault.setupPrivateSession('Packaged synthetic password 7294');
    await window.vault.createFolder('', 'Private folder 6829');
    const note = await window.vault.createPrivateCopy('Private folder 6829', 'Private title 9201', 'Packaged private token 2389', session.sessionId);
    await window.vault.lockPrivateSession();
    let denied = false;
    try { await window.vault.readNote(note.path); } catch { denied = true; }
    return { denied, entries: await window.vault.listEntries() };
  });
  assert.equal(privateResult.denied, true);
  assert.deepEqual(privateResult.entries, []);
  const sealed = await readFile(path.join(vault, '.black-cobble-private', 'vault.sealed'), 'utf8');
  for (const secret of ['Packaged private token', 'Private folder 6829', 'Private title 9201']) assert.ok(!sealed.includes(secret));
} finally {
  await app.close();
}
assert.match(await readFile(path.join(vault, 'Prueba.md'), 'utf8'), /Guardado desde el ejecutable\./);
console.log('Ejecutable empaquetado: apertura, edición, guardado, cifrado y bloqueo correctos.');
