import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  build: {
    outDir: mode === 'tauri' ? 'dist-tauri' : 'dist',
    target: mode === 'tauri' ? 'es2019' : 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
}))
