import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
export default defineConfig(({ command }) => {
  const nonce = command === 'serve' ? randomBytes(24).toString('base64') : undefined;
  return {
    plugins: [react(), { name: 'development-csp', transformIndexHtml: { order: 'pre', handler: html => nonce ? html.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`) : html } }],
    html: { cspNonce: nonce },
    base: './',
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
  };
});
