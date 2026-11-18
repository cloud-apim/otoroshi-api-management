import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// the portal is served under /<workspace>/ (path exposure) or at the root of <workspace>.<domain>
// (hostname exposure): its assets live under a fixed /_portal/ prefix in both cases.
export default defineConfig({
  root: fileURLToPath(new URL('./portal', import.meta.url)),
  base: '/_portal/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/portal', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 6000,
  },
});
