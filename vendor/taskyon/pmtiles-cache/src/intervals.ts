/** Half-open byte range in the original archive address space. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

/** A byte range whose bytes live at `packOffset` inside the immutable pack `packId`. */
export interface CacheFrame extends ByteRange {
  readonly packId: string
  readonly packOffset: number
}

export const intersectRanges = (left: ByteRange, right: ByteRange): ByteRange | undefined => {
  const start = Math.max(left.start, right.start)
  const end = Math.min(left.end, right.end)
  return end > start ? { start, end } : undefined
}

/** Sort and merge overlapping or adjacent ranges. */
export const mergeRanges = (ranges: readonly ByteRange[]): ByteRange[] => {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: ByteRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end) {
      const end = Math.max(previous.end, range.end)
      merged[merged.length - 1] = { start: previous.start, end }
      continue
    }
    merged.push({ start: range.start, end: range.end })
  }
  return merged
}

/** Return the exact complement of `covered` inside `request`. */
export const subtractRanges = (covered: readonly ByteRange[], request: ByteRange): ByteRange[] => {
  const gaps: ByteRange[] = []
  let cursor = request.start
  for (const range of mergeRanges(covered)) {
    if (range.end <= cursor) continue
    if (range.start >= request.end) break
    const localStart = Math.max(range.start, request.start)
    if (localStart > cursor) gaps.push({ start: cursor, end: Math.min(localStart, request.end) })
    cursor = Math.max(cursor, Math.min(range.end, request.end))
    if (cursor >= request.end) break
  }
  if (cursor < request.end) gaps.push({ start: cursor, end: request.end })
  return gaps
}

/**
 * Binary-search the first frame that can intersect `request`, then walk the
 * intersecting frames. Frames must be sorted and non-overlapping.
 */
export const findFrames = (frames: readonly CacheFrame[], request: ByteRange): CacheFrame[] => {
  let low = 0
  let high = frames.length
  while (low < high) {
    const middle = (low + high) >> 1
    const frame = frames[middle]
    if (!frame || frame.end <= request.start) low = middle + 1
    else high = middle
  }
  const found: CacheFrame[] = []
  for (let index = low; index < frames.length; index += 1) {
    const frame = frames[index]
    if (!frame || frame.start >= request.end) break
    if (frame.end > request.start) found.push(frame)
  }
  return found
}

/**
 * Add new frames to an existing sorted frame list. New frames are trimmed
 * against bytes already covered by either the existing frames or earlier
 * additions. Existing coverage always wins so concurrent fetches of the same
 * source bytes cannot publish overlapping intervals.
 */
export const insertFrames = (
  existing: readonly CacheFrame[],
  additions: readonly CacheFrame[],
): CacheFrame[] => {
  const covered: ByteRange[] = existing.map(({ start, end }) => ({ start, end }))
  const accepted: CacheFrame[] = [...existing]
  const ordered = [...additions].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
  for (const addition of ordered) {
    for (const gap of subtractRanges(covered, addition)) {
      accepted.push({
        start: gap.start,
        end: gap.end,
        packId: addition.packId,
        packOffset: addition.packOffset + (gap.start - addition.start),
      })
      covered.push(gap)
      if (covered.length > 1) covered.splice(0, covered.length, ...mergeRanges(covered))
    }
  }
  return accepted.sort((left, right) => left.start - right.start)
}

const isInteger = (value: number): boolean => Number.isSafeInteger(value)

export const parseCacheFrames = (value: unknown): CacheFrame[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const frames: CacheFrame[] = []
  let previousEnd = -1
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const frame = item as Partial<CacheFrame>
    if (
      !isInteger(frame.start as number) ||
      !isInteger(frame.end as number) ||
      !isInteger(frame.packOffset as number) ||
      (frame.start as number) < 0 ||
      (frame.end as number) <= (frame.start as number) ||
      (frame.packOffset as number) < 0 ||
      typeof frame.packId !== 'string' ||
      frame.packId.length === 0
    )
      return undefined
    if ((frame.start as number) < previousEnd) return undefined
    previousEnd = frame.end as number
    frames.push({
      start: frame.start as number,
      end: frame.end as number,
      packId: frame.packId,
      packOffset: frame.packOffset as number,
    })
  }
  return frames
}
