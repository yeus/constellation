import assert from 'node:assert/strict'
import test from 'node:test'
import { loadLocalSharingPreference, saveLocalSharingPreference } from './sharingPreference.ts'

const store = () => {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

test('desired background policy remains selected separately from foreground execution', () => {
  const storage = store()
  const desired = {
    publication: 'background' as const,
    battery: 'saver' as const,
    network: 'pause-when-metered' as const,
  }
  assert.equal(saveLocalSharingPreference(storage, desired), true)
  assert.deepEqual(loadLocalSharingPreference(storage), desired)
})

test('corrupt or inaccessible preferences use a safe fallback rather than throwing', () => {
  const storage = store()
  storage.setItem('constellation.sharing-behavior-preference', '{bad json')
  assert.equal(loadLocalSharingPreference(storage), undefined)
  assert.equal(
    saveLocalSharingPreference(
      {
        setItem: () => {
          throw new Error('storage denied')
        },
      },
      { publication: 'foreground', battery: 'balanced', network: 'always' },
    ),
    false,
  )
})
