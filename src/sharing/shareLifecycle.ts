export const MAX_END_NOTIFICATIONS = 32
export const END_NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export const retainedEndNotifications = <T extends { endedAt: number }>(
  records: readonly T[],
  now = Date.now(),
): T[] =>
  records
    .filter((record) => record.endedAt + END_NOTICE_RETENTION_MS > now)
    .sort((left, right) => right.endedAt - left.endedAt)
    .slice(0, MAX_END_NOTIFICATIONS)
