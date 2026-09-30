import assert from 'node:assert/strict'
import vm from 'node:vm'
import test from 'node:test'

import { compileAndroidWebViewExpression } from './android-cdp-source.mjs'

test('compiles injected WebView expressions to the Android 10 syntax target', async () => {
  const source = await compileAndroidWebViewExpression('globalThis.sample?.value ?? 0')
  assert.doesNotMatch(source, /\?\.|\?\?/)
  assert.equal(vm.runInNewContext(source, { sample: { value: 7 } }), 7)
})
