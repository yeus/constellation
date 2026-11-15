import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BACKGROUND_FOLLOWING_KEY,
  readBackgroundFollowingPreference,
  persistBackgroundFollowingPreference,
  resolveNativeFollowingPreference,
} from './backgroundFollowingPreference.ts'

const memoryStorage = () => {
  const records = new Map<string, string>()
  return {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => void records.set(key, value),
  }
}

test('background following defaults on with no peers or receiver and survives settings reloads', () => {
  const storage = memoryStorage()
  assert.equal(readBackgroundFollowingPreference(storage), true)
  assert.equal(persistBackgroundFollowingPreference(storage, false), true)
  assert.equal(storage.getItem(BACKGROUND_FOLLOWING_KEY), 'off')
  assert.equal(readBackgroundFollowingPreference(storage), false)
  assert.equal(persistBackgroundFollowingPreference(storage, true), true)
  assert.equal(readBackgroundFollowingPreference(storage), true)
  assert.equal(storage.getItem(BACKGROUND_FOLLOWING_KEY), 'on')
})

test('an unavailable WebView storage does not silently report a successful save', () => {
  const unavailable = {
    getItem: (): string | null => {
      throw new Error('storage unavailable')
    },
    setItem: (): void => {
      throw new Error('storage unavailable')
    },
  }
  assert.equal(readBackgroundFollowingPreference(unavailable), true)
  assert.equal(persistBackgroundFollowingPreference(unavailable, false), false)
})
test('native opt-out wins over stale WebView opt-in without writing a second preference', async () => {
  let writes = 0
  assert.equal(
    await resolveNativeFollowingPreference(
      false,
      () => true,
      async () => {
        writes++
        return true
      },
    ),
    false,
  )
  assert.equal(writes, 0)
})

test('legacy opt-out migrates once and only after durable native confirmation', async () => {
  const saved: boolean[] = []
  const migrate = async (enabled: boolean): Promise<boolean> => {
    saved.push(enabled)
    return enabled
  }
  assert.equal(await resolveNativeFollowingPreference(null, () => false, migrate), false)
  assert.deepEqual(saved, [false])
  assert.equal(await resolveNativeFollowingPreference(false, () => true, migrate), false)
  assert.deepEqual(saved, [false])
  await assert.rejects(
    resolveNativeFollowingPreference(
      undefined,
      () => false,
      async () => true,
    ),
    /could not confirm/,
  )
})
