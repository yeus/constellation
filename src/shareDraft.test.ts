import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acknowledgeUntilRevoked,
  canCreateShare,
  createShareDraft,
  disclosedPrecisionFor,
  setBatteryPolicy,
  setDuration,
  setName,
  setNetworkPolicy,
  setPublication,
  setPrecision,
  setViewerCapacity,
} from './shareDraft.ts'

test('new shares use privacy-preserving defaults', () => {
  assert.deepEqual(createShareDraft(), {
    precision: 'approximate',
    duration: '1h',
    viewerCapacity: 1,
    untilRevokedAcknowledged: false,
    name: '',
    publication: 'foreground',
    battery: 'balanced',
    network: 'always',
  })
})

test('battery and metered policy stay independent per link', () => {
  const initial = createShareDraft()
  const saver = setBatteryPolicy(initial, 'saver')
  const pausing = setNetworkPolicy(saver, 'pause-when-metered')

  assert.equal(initial.battery, 'balanced')
  assert.equal(initial.network, 'always')
  assert.equal(saver.battery, 'saver')
  assert.equal(saver.network, 'always')
  assert.equal(pausing.battery, 'saver')
  assert.equal(pausing.network, 'pause-when-metered')
  assert.notEqual(saver, initial)
  assert.notEqual(pausing, saver)
})

test('foreground-only sharing drops hidden background policy effects', () => {
  const background = setNetworkPolicy(
    setBatteryPolicy(setPublication(createShareDraft(), 'background'), 'saver'),
    'pause-when-metered',
  )
  const foreground = setPublication(background, 'foreground')

  assert.equal(foreground.publication, 'foreground')
  assert.equal(foreground.battery, 'balanced')
  assert.equal(foreground.network, 'always')

  const backgroundAgain = setPublication(foreground, 'background')
  assert.equal(backgroundAgain.battery, 'balanced')
  assert.equal(backgroundAgain.network, 'always')
})

test('name and publication mode remain independent per link', () => {
  const initial = createShareDraft()
  const named = setName(initial, '  River  ')
  const background = setPublication(named, 'background')

  assert.equal(initial.name, '')
  assert.equal(named.name, 'River')
  assert.equal(background.publication, 'background')
  assert.equal(canCreateShare(setName(initial, 'x'.repeat(33))), false)
})

test('share updates return new drafts without mutating the original', () => {
  const initial = createShareDraft()
  const exact = setPrecision(initial, 'exact')
  const expanded = setViewerCapacity(exact, 10)

  assert.equal(initial.precision, 'approximate')
  assert.equal(exact.precision, 'exact')
  assert.equal(expanded.viewerCapacity, 10)
  assert.notEqual(initial, exact)
  assert.notEqual(exact, expanded)
})

test('very coarse is an independent source choice and does not change the default', () => {
  const initial = createShareDraft()
  const broad = setPrecision(initial, 'very-coarse')

  assert.equal(initial.precision, 'approximate')
  assert.equal(broad.precision, 'very-coarse')
  assert.equal(disclosedPrecisionFor(broad.precision), 'approximate')
  assert.equal(disclosedPrecisionFor('exact'), 'exact')
  assert.equal(canCreateShare(broad), true)
})

test('until-revoked sharing requires explicit acknowledgement every time', () => {
  const indefinite = setDuration(createShareDraft(), 'until-revoked')
  assert.equal(canCreateShare(indefinite), false)

  const acknowledged = acknowledgeUntilRevoked(indefinite, true)
  assert.equal(canCreateShare(acknowledged), true)

  const timed = setDuration(acknowledged, '8h')
  const indefiniteAgain = setDuration(timed, 'until-revoked')
  assert.equal(indefiniteAgain.untilRevokedAcknowledged, false)
  assert.equal(canCreateShare(indefiniteAgain), false)
})
