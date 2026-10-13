import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultSharingBehavior, SharingBehavior } from './sharingBehavior.ts'

test('Android defaults to background; other platforms default to foreground', () => {
  assert.deepEqual(defaultSharingBehavior(true), {
    publication: 'background',
    battery: 'balanced',
    network: 'always',
  })
  assert.deepEqual(defaultSharingBehavior(false), {
    publication: 'foreground',
    battery: 'balanced',
    network: 'always',
  })
})
test('global settings validate the existing policies without introducing link options', () => {
  assert.equal(
    SharingBehavior.safeParse({
      publication: 'background',
      battery: 'saver',
      network: 'pause-when-metered',
    }).success,
    true,
  )
  assert.equal(
    SharingBehavior.safeParse({ publication: 'scheduled', battery: 'balanced', network: 'always' })
      .success,
    false,
  )
})
