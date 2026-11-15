import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canConfigureBackgroundSharing,
  canStartBackgroundShare,
  effectiveSharingBehavior,
  sharingFallbackNotice,
  deviceLocationNotice,
} from './locationReadiness.ts'

const granted = { location: true, background: true, notifications: true, servicesEnabled: true }

test('device location toggle does not prevent editing saved sharing preferences', () => {
  assert.equal(canConfigureBackgroundSharing({ ...granted, servicesEnabled: false }), true)
  assert.equal(canStartBackgroundShare({ ...granted, servicesEnabled: false }), false)
  assert.equal(canStartBackgroundShare(granted), true)
  assert.equal(canConfigureBackgroundSharing({ ...granted, background: false }), false)
})

test('permission changes do not mutate the requested sharing policy', () => {
  const requested = {
    publication: 'background' as const,
    battery: 'saver' as const,
    network: 'pause-when-metered' as const,
  }
  const missing = { ...granted, background: false }
  assert.deepEqual(effectiveSharingBehavior(requested, true, missing), {
    ...requested,
    publication: 'foreground',
  })
  assert.deepEqual(effectiveSharingBehavior(requested, true, granted), requested)
  assert.deepEqual(effectiveSharingBehavior(requested, false, granted), {
    ...requested,
    publication: 'foreground',
  })
  assert.match(
    sharingFallbackNotice(requested, true, missing) ?? '',
    /Effective fallback: location sharing only while the app is open/,
  )
  assert.match(
    sharingFallbackNotice(requested, true, { ...missing, servicesEnabled: false }) ?? '',
    /no location updates until device Location is enabled/,
  )
  assert.equal(sharingFallbackNotice(requested, true, granted), undefined)
  assert.equal(requested.publication, 'background')
})

test('device location disabled has an explicit, persistent user-facing explanation', () => {
  assert.match(deviceLocationNotice(false, 2), /Location is off on this device/)
  assert.match(deviceLocationNotice(false, 2), /existing sharing links/)
  assert.match(deviceLocationNotice(false, 0), /turn it on in Android Settings/)
  assert.equal(deviceLocationNotice(true, 2), '')
})
