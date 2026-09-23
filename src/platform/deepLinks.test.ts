import assert from 'node:assert/strict'
import test from 'node:test'

import { firstAllowedDeepLink } from './deepLinks.ts'

test('accepts only the configured public share origin and path', () => {
  const allowed = 'https://constellation.taskyon.space/'

  assert.equal(
    firstAllowedDeepLink(
      ['https://example.invalid/#share=bad', 'https://constellation.taskyon.space/#share=good'],
      allowed,
    ),
    'https://constellation.taskyon.space/#share=good',
  )
  assert.equal(
    firstAllowedDeepLink(['https://constellation.taskyon.space/other#share=bad'], allowed),
    undefined,
  )
})
