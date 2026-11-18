import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./backoffice', import.meta.url)),
  base: '/backoffice/',
  plugins: [react()],
  // monaco's package exports map every path to a .js file; its css and internal modules are
  // reached through this alias (see web/shared/monaco-setup.js)
  resolve: { alias: { '@monaco': fileURLToPath(new URL('../node_modules/monaco-editor/esm/vs', import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL('../dist/backoffice', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
