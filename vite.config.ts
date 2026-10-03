import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const packageMetadata = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  let gitCommit = 'unknown'
  try {
    gitCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // Source archives without .git provide the commit through the build environment.
  }
  const commit = process.env.CONSTELLATION_BUILD_COMMIT || process.env.GITHUB_SHA || gitCommit
  const buildDate = process.env.CONSTELLATION_BUILD_DATE || new Date().toISOString()
  const builtAt = new Date(buildDate)
  if (Number.isNaN(builtAt.getTime())) {
    throw new Error('CONSTELLATION_BUILD_DATE must be a valid date.')
  }

  return {
    plugins: [vue()],
    define: {
      __CONSTELLATION_BUILD_METADATA__: JSON.stringify({
        version: packageMetadata.version,
        commit,
        builtAt: builtAt.toISOString(),
      }),
    },
    build: {
      outDir: mode === 'tauri' ? 'dist-tauri' : 'dist',
      target: mode === 'tauri' ? 'es2019' : 'es2022',
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
  }
})
