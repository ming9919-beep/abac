import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'artifacts/api-server/**/*.test.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      // artifacts/aba-mobile 是历史副本，不参与本仓库测试
      'artifacts/aba-mobile/**',
      'artifacts/**/dist/**',
    ],
    css: false,
  },
});
