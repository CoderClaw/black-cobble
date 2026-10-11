import { build } from 'esbuild';

export const buildElectron = () => build({ entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/search-worker.ts'], bundle: true, platform: 'node', format: 'cjs', outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, external: ['electron'], sourcemap: true });
