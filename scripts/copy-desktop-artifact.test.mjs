import assert from 'node:assert/strict'
import test from 'node:test'

import { desktopArtifactName } from './copy-desktop-artifact.mjs'

test('names desktop artifacts with version and architecture', () => {
  assert.equal(
    desktopArtifactName('0.1.0', 'x86_64'),
    'constellation-desktop-0.1.0-x86_64.AppImage',
  )
})
