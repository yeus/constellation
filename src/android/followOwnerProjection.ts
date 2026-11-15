import type { FollowSummary } from '../sharing/sharingContracts.ts'
import type { BackgroundViewerSnapshot } from './backgroundViewer.ts'

/**
 * A background service owns the live follow counters, observations and trace.
 * Never mix them with an Activity snapshot captured before the ownership handoff.
 */
export const projectFollowOwnerState = (
  activity: readonly FollowSummary[],
  owner: 'activity' | 'service',
  receiver: BackgroundViewerSnapshot | undefined,
): FollowSummary[] => {
  if (owner === 'activity') return [...activity]
  const native = new Map(receiver?.following.map((follow) => [follow.shareId, follow]))
  const observations = new Map(
    receiver?.received.map(({ shareId, observation }) => [shareId, observation]),
  )
  return activity.map((entry) => {
    if (!entry.saved) return entry
    const identity = { ...entry, lastLocationAt: undefined, trace: undefined }
    const current = native.get(entry.shareId)
    if (!current) {
      return {
        ...identity,
        connected: false,
        status: 'unavailable',
        updatesReceived: 0,
        receiverStatusPending: true,
      }
    }
    const lastLocationAt = Math.max(
      current.lastLocationAt ?? 0,
      observations.get(entry.shareId)?.capturedAt ?? 0,
      current.traceEnabled
        ? (current.trace?.filter((event) => event.type === 'location').at(-1)?.capturedAt ?? 0)
        : 0,
    )
    return {
      ...identity,
      connected: current.connected,
      status: current.status,
      updatesReceived: current.updatesReceived,
      traceEnabled: current.traceEnabled === true,
      ...(current.traceEnabled ? { trace: current.trace ?? [] } : {}),
      ...(lastLocationAt > 0 ? { lastLocationAt } : {}),
      receiverStatusPending: false,
    }
  })
}
