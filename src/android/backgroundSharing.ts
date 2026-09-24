import type { BrowserLocationState } from '../location/browser.ts'
import { shareExpiryFor, type ShareDraft } from '../shareDraft.ts'
import type { ShareSummary } from '../sharing/sharingRuntime.ts'

export interface AndroidBackgroundStatus {
  readonly state: 'starting' | 'sharing' | 'paused' | 'stopped' | 'error'
  readonly share?: ShareSummary
  readonly location: BrowserLocationState
  readonly message: string
}

interface AndroidBackgroundSharingDependencies {
  readonly isAndroid: boolean
  readonly now: () => number
  readonly preparePermissions?: () => Promise<void>
  readonly invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
}

const isLocationState = (value: unknown): value is BrowserLocationState => {
  if (!value || typeof value !== 'object' || !('status' in value)) return false
  return [
    'permission-required',
    'acquiring',
    'live',
    'delayed',
    'stale',
    'denied',
    'unavailable',
    'error',
  ].includes(String(value.status))
}

const parseStatus = (value: unknown): AndroidBackgroundStatus => {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid background sharing status.')
  }
  const candidate = value as Partial<AndroidBackgroundStatus>
  if (
    !['starting', 'sharing', 'paused', 'stopped', 'error'].includes(String(candidate.state)) ||
    !isLocationState(candidate.location) ||
    typeof candidate.message !== 'string'
  ) {
    throw new Error('Invalid background sharing status.')
  }
  if (candidate.state === 'sharing') {
    const share = candidate.share
    if (
      !share ||
      typeof share.shareId !== 'string' ||
      typeof share.url !== 'string' ||
      typeof share.viewerCount !== 'number'
    ) {
      throw new Error('Invalid background sharing status.')
    }
  }
  return candidate as AndroidBackgroundStatus
}

export const createAndroidBackgroundSharing = (
  dependencies: AndroidBackgroundSharingDependencies,
):
  | {
      start: (draft: ShareDraft, shareBaseUrl: string) => Promise<AndroidBackgroundStatus>
      status: () => Promise<AndroidBackgroundStatus>
      stop: () => Promise<AndroidBackgroundStatus>
    }
  | undefined => {
  if (!dependencies.isAndroid) return undefined
  const status = async () =>
    parseStatus(await dependencies.invoke('android_background_share_status'))
  return {
    start: async (draft, shareBaseUrl) => {
      await dependencies.preparePermissions?.()
      return parseStatus(
        await dependencies.invoke('android_start_background_share', {
          request: {
            precision: draft.precision,
            viewerCapacity: draft.viewerCapacity,
            name: draft.name,
            expiresAt: shareExpiryFor(draft, dependencies.now()),
            shareBaseUrl,
          },
        }),
      )
    },
    status,
    stop: async () => parseStatus(await dependencies.invoke('android_stop_background_share')),
  }
}
