import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3501,
    proxy: {
      '/api': 'http://127.0.0.1:3500',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
