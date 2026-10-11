import { spawnSync } from 'node:child_process';

const targets = { win32: 'package:win', linux: 'package:linux' };
const script = targets[process.platform];
if (!script) {
  console.error(`No hay empaquetado para la plataforma "${process.platform}". Usa Windows (npm run package:win) o Linux (npm run package:linux).`);
  process.exit(1);
}
const result = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) {
  console.error(`No se pudo ejecutar npm: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
