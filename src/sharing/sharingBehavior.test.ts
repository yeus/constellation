import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultSharingBehavior, SharingBehavior } from './sharingBehavior.ts'

test('Android defaults to background; other platforms default to foreground', () => {
  assert.deepEqual(defaultSharingBehavior(true), {
    publication: 'background',
    battery: 'saver',
    network: 'always',
    locationProvider: 'automatic',
    activeViewingBoost: true,
    backgroundIntervalMinutes: 5,
  })
  assert.deepEqual(defaultSharingBehavior(false), {
    publication: 'foreground',
    battery: 'balanced',
    network: 'always',
    locationProvider: 'automatic',
    activeViewingBoost: true,
    backgroundIntervalMinutes: 5,
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
test('network-only native acquisition is optional and legacy preferences still parse', () => {
  const legacy = { publication: 'background', battery: 'saver', network: 'always' }
  assert.equal(SharingBehavior.safeParse(legacy).success, true)
  assert.equal(SharingBehavior.safeParse({ ...legacy, backgroundIntervalMinutes: 5 }).success, true)
  assert.equal(
    SharingBehavior.safeParse({ ...legacy, backgroundIntervalMinutes: 3 }).success,
    false,
  )
  assert.equal(
    SharingBehavior.safeParse({ ...legacy, locationProvider: 'network-only' }).success,
    true,
  )
  assert.equal(
    SharingBehavior.safeParse({ ...legacy, locationProvider: 'gps-only' }).success,
    false,
  )
})
