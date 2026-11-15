import { SharingBehavior, type SharingBehavior as Behavior } from './sharingBehavior.ts'

/** On Android the native encrypted store owns this preference instead. */
const STORAGE_KEY = 'constellation.sharing-behavior-preference'

export const loadLocalSharingPreference = (
  storage: Pick<Storage, 'getItem'>,
): Behavior | undefined => {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    return SharingBehavior.safeParse(JSON.parse(raw)).data
  } catch {
    return undefined
  }
}

export const saveLocalSharingPreference = (
  storage: Pick<Storage, 'setItem'>,
  behavior: Behavior,
): boolean => {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(SharingBehavior.parse(behavior)))
    return true
  } catch {
    return false
  }
}
