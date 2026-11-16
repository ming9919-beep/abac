import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

// Override only the cache dir so vite can write dependency pre-bundles
// outside the sandbox-restricted node_modules/.vite path.
export default mergeConfig(
  base as any,
  defineConfig({
    cacheDir: 'C:/Users/heng/AppData/Local/Temp/aba-vite-cache',
  }),
);
