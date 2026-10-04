import assert from 'node:assert/strict'
import test from 'node:test'
import { canCreateShare, createShareDraft } from '../shareDraft.ts'
import { LOCATION_PROFILE_V1 } from '../location/locationObservation.ts'
import { createAndroidBackgroundSharing } from '../android/backgroundSharing.ts'
import {
  runNativeDiagnostic,
  type SharingDiagnosticDependencies,
} from './sharingDiagnosticCases.ts'

for (const duplicate of [false, true]) {
  test(`native diagnostic cleans only owned shares on ${duplicate ? 'duplicate creation' : 'cancellation'}`, async () => {
    const controller = new AbortController()
    const stopped: string[] = []
    const share = (shareId: string, name = 'Synthetic share') => ({
      shareId,
      url: 'https://example.test/',
      name,
      precision: 'exact',
      expiresAt: 60_000,
      viewerCount: 0,
      publication: 'background',
    })
    let shares = [share('synthetic-ordinary')]
    const status = () => ({
      state: 'sharing',
      shares,
      message: '',
      location: { status: 'acquiring' },
    })
    const native = createAndroidBackgroundSharing({
      isAndroid: true,
      now: () => 0,
      invoke: (command, args) => {
        if (command === 'android_start_background_share') {
          const name = (args?.request as { name: string }).name
          assert.equal(canCreateShare({ ...createShareDraft(), name }), true)
          shares = [
            ...shares,
            share('synthetic-concurrent'),
            share('synthetic-test', name),
            ...(duplicate ? [share('synthetic-duplicate', name)] : []),
          ]
        }
        if (command === 'android_stop_background_share') {
          stopped.push(String(args?.shareId))
          shares = shares.filter((entry) => entry.shareId !== args?.shareId)
        }
        return Promise.resolve(status())
      },
    })!
    const dependencies: SharingDiagnosticDependencies = {
      shareBaseUrl: 'https://example.test/',
      native,
      createSession: () => {
        throw new Error('Unexpected synthetic session')
      },
      capabilities: () => ({ secureContext: true, crypto: true, webRTC: true }),
      pairing: () => ({ role: 'host', url: '' }),
      invitation: () => {
        controller.abort()
      },
      stage: () => undefined,
      visibility: { isHidden: () => false, subscribe: () => () => undefined },
    }
    await assert.rejects(runNativeDiagnostic(dependencies, controller.signal))
    assert.deepEqual(
      stopped.sort(),
      duplicate ? ['synthetic-duplicate', 'synthetic-test'] : ['synthetic-test'],
    )
    assert.deepEqual(
      shares.map((entry) => entry.shareId),
      ['synthetic-ordinary', 'synthetic-concurrent'],
    )
  })
}

for (const freshDuringLock of [true, false]) {
  test(`native check ${freshDuringLock ? 'passes with a recorded locked fix' : 'skips without locked-fix evidence'}`, async () => {
    let visibility: (hidden: boolean) => void = () => undefined
    let hidden = false
    let reads = 0
    const stopped: string[] = []
    const share = {
      shareId: 'synthetic-native-test',
      name: 'Synthetic share',
      url: 'https://example.test/',
      precision: 'exact',
      expiresAt: 60_000,
      viewerCount: 1,
      publication: 'background',
    }
    let shares: (typeof share)[] = []
    let observation = {
      profile: LOCATION_PROFILE_V1,
      sourceId: 'synthetic',
      precision: 'exact',
      sequence: 1,
      capturedAt: Date.now() - 5_000,
      expiresAt: Date.now() + 60_000,
      latitude: 40,
      longitude: 20,
      accuracyMeters: 12,
    }
    const status = () => ({
      state: 'sharing',
      shares,
      message: '',
      location: { status: 'live', observation },
    })
    const native = createAndroidBackgroundSharing({
      isAndroid: true,
      now: () => 0,
      invoke: (command, args) => {
        if (command === 'android_start_background_share')
          shares = [{ ...share, name: (args?.request as { name: string }).name }]
        if (command === 'android_background_share_status' && ++reads === 3) {
          hidden = true
          visibility(true)
          if (freshDuringLock) observation = { ...observation, sequence: 2, capturedAt: Date.now() }
          hidden = false
          visibility(false)
        }
        if (command === 'android_stop_background_share') {
          stopped.push(String(args?.shareId))
          shares = []
        }
        return Promise.resolve(status())
      },
    })!
    const result = await runNativeDiagnostic(
      {
        shareBaseUrl: 'https://example.test/',
        native,
        createSession: () => {
          throw new Error('Unexpected synthetic session')
        },
        capabilities: () => ({ secureContext: true, crypto: true, webRTC: true }),
        pairing: () => ({ role: 'host', url: '' }),
        invitation: () => undefined,
        stage: () => undefined,
        visibility: {
          isHidden: () => hidden,
          subscribe: (listener) => {
            visibility = listener
            return () => undefined
          },
        },
      },
      new AbortController().signal,
    )
    assert.deepEqual(
      result,
      freshDuringLock
        ? { code: 'background-lock-resume-verified' }
        : { skipped: true, reason: 'background-fix-evidence-unavailable' },
    )
    assert.deepEqual(stopped, ['synthetic-native-test'])
  })
}

for (const failure of ['invalid-start-status', 'cleanup-failure']) {
  test(`native diagnostics reconcile owned links after ${failure}`, async () => {
    const stopped: string[] = []
    let shares: Array<{
      shareId: string
      name: string
      url: string
      precision: string
      expiresAt: number
      viewerCount: number
    }> = []
    const status = () => ({
      state: 'sharing',
      shares,
      message: '',
      location: { status: 'acquiring' },
    })
    const native = createAndroidBackgroundSharing({
      isAndroid: true,
      now: () => 0,
      invoke: (command, args) => {
        if (command === 'android_start_background_share') {
          const name = (args?.request as { name: string }).name
          assert.equal(canCreateShare({ ...createShareDraft(), name }), true)
          shares = ['synthetic-first', 'synthetic-second'].map((shareId) => ({
            shareId,
            name,
            url: 'https://example.test/',
            precision: 'exact',
            expiresAt: 60_000,
            viewerCount: 0,
          }))
          if (failure === 'invalid-start-status') return Promise.resolve({ invalid: true })
        }
        if (command === 'android_stop_background_share') {
          stopped.push(String(args?.shareId))
          if (failure === 'cleanup-failure' && args?.shareId === 'synthetic-first')
            return Promise.reject(new Error('Synthetic stop failure'))
          shares = shares.filter((entry) => entry.shareId !== args?.shareId)
        }
        return Promise.resolve(status())
      },
    })!
    await assert.rejects(
      runNativeDiagnostic(
        {
          shareBaseUrl: 'https://example.test/',
          native,
          createSession: () => {
            throw new Error('Unexpected synthetic session')
          },
          capabilities: () => ({ secureContext: true, crypto: true, webRTC: true }),
          pairing: () => ({ role: 'host', url: '' }),
          invitation: () => undefined,
          stage: () => undefined,
          visibility: { isHidden: () => false, subscribe: () => () => undefined },
        },
        new AbortController().signal,
      ),
    )
    assert.deepEqual(stopped.sort(), ['synthetic-first', 'synthetic-second'])
  })
}
