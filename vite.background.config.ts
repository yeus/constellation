import { readFileSync } from 'node:fs'

import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'chrome74',
    emptyOutDir: true,
    outDir: 'dist-background',
    lib: {
      entry: 'src/android/backgroundEntry.ts',
      formats: ['iife'],
      name: 'ConstellationBackground',
      fileName: () => 'constellation-background.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        banner: () =>
          `${readFileSync(new URL('./public/legacy-compat.js', import.meta.url), 'utf8')}\n;`,
      },
    },
  },
})
