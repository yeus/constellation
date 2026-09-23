import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    emptyOutDir: true,
    outDir: 'dist-background',
    lib: {
      entry: 'src/android/backgroundEntry.ts',
      formats: ['iife'],
      name: 'ConstellationBackground',
      fileName: () => 'constellation-background.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
})
