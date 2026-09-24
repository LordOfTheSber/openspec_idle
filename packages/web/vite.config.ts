import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Относительные адреса ресурсов: одна и та же сборка открывается и с
  // локального сервера, и из файлов расширения VS Code.
  base: './',
  resolve: {
    alias: {
      '@openspec-ide/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
