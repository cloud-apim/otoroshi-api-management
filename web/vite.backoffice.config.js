import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./backoffice', import.meta.url)),
  base: '/backoffice/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/backoffice', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
