import js from '@eslint/js'
import prettierSkipFormatting from '@vue/eslint-config-prettier/skip-formatting'
import {
  configureVueProject,
  defineConfigWithVueTs,
  vueTsConfigs,
} from '@vue/eslint-config-typescript'
import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'

configureVueProject({ rootDir: import.meta.dirname })

export default defineConfigWithVueTs(
  {
    ignores: [
      '.tmp/**',
      'dist/**',
      'dist-tauri/**',
      'dist-background/**',
      'src-tauri/**',
      'vendor/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.ts', '**/*.vue'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  {
    files: ['**/*.vue'],
    rules: { 'vue/require-default-prop': 'off' },
  },
  vueTsConfigs.recommendedTypeChecked,
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'off',
      'prefer-promise-reject-errors': 'off',
    },
  },
  prettierSkipFormatting,
)
