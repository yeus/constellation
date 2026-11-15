import type { FollowStatus } from './sharingContracts.ts'

const statusName: Record<FollowStatus, string> = {
  live: 'Live',
  delayed: 'Delayed',
  stale: 'Stale',
  unavailable: 'Not connected',
  expired: 'Expired',
  revoked: 'Revoked',
  'approval-pending': 'Waiting for sender approval',
  denied: 'Access not approved',
}

const age = (timestamp: number, now: number): string => {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`
}

/** lastLocationAt is the sender's capturedAt, not the receiver's arrival timestamp. */
export const followActivitySummary = (
  status: FollowStatus,
  lastLocationAt: number | undefined,
  now = Date.now(),
): string =>
  `${statusName[status]} · ${lastLocationAt ? `Last location from ${age(lastLocationAt, now)} ago` : 'No location received'}`
