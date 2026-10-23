/* eslint-disable @typescript-eslint/no-floating-promises -- node:test and deterministic fetch doubles intentionally use unawaited promises */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findFrames,
  insertFrames,
  mergeRanges,
  parseCacheFrames,
  subtractRanges,
  type CacheFrame,
} from './intervals.ts'

test('mergeRanges sorts, merges overlaps and joins adjacent coverage', () => {
  assert.deepEqual(
    mergeRanges([
      { start: 160, end: 200 },
      { start: 100, end: 140 },
      { start: 130, end: 165 },
    ]),
    [{ start: 100, end: 200 }],
  )
})

test('subtractRanges returns only the missing interior gap', () => {
  assert.deepEqual(
    subtractRanges(
      [
        { start: 100, end: 140 },
        { start: 160, end: 200 },
      ],
      { start: 100, end: 200 },
    ),
    [{ start: 140, end: 160 }],
  )
})

test('subtractRanges handles fully covered, empty and partial requests', () => {
  const covered = [{ start: 100, end: 200 }]
  assert.deepEqual(subtractRanges(covered, { start: 120, end: 180 }), [])
  assert.deepEqual(subtractRanges(covered, { start: 80, end: 120 }), [{ start: 80, end: 100 }])
  assert.deepEqual(subtractRanges([], { start: 7, end: 9 }), [{ start: 7, end: 9 }])
})

test('findFrames binary-searches intersecting sorted frames', () => {
  const frames: CacheFrame[] = [
    { start: 10, end: 20, packId: 'p1', packOffset: 0 },
    { start: 30, end: 40, packId: 'p2', packOffset: 0 },
    { start: 50, end: 60, packId: 'p3', packOffset: 0 },
  ]
  assert.deepEqual(findFrames(frames, { start: 35, end: 55 }), [frames[1], frames[2]])
  assert.deepEqual(findFrames(frames, { start: 20, end: 30 }), [])
  assert.deepEqual(findFrames(frames, { start: 0, end: 100 }), frames)
})

test('insertFrames trims duplicates and keeps pack offsets aligned', () => {
  const existing: CacheFrame[] = [{ start: 100, end: 140, packId: 'pOld', packOffset: 0 }]
  const additions: CacheFrame[] = [{ start: 120, end: 160, packId: 'pNew', packOffset: 10 }]
  assert.deepEqual(insertFrames(existing, additions), [
    { start: 100, end: 140, packId: 'pOld', packOffset: 0 },
    { start: 140, end: 160, packId: 'pNew', packOffset: 30 },
  ])
})

test('insertFrames lets earlier additions win over later overlapping additions', () => {
  const first: CacheFrame[] = [{ start: 0, end: 50, packId: 'pA', packOffset: 0 }]
  const second: CacheFrame[] = [
    { start: 20, end: 80, packId: 'pB', packOffset: 100 },
    { start: 80, end: 100, packId: 'pB', packOffset: 160 },
  ]
  assert.deepEqual(insertFrames(first, second), [
    { start: 0, end: 50, packId: 'pA', packOffset: 0 },
    { start: 50, end: 80, packId: 'pB', packOffset: 130 },
    { start: 80, end: 100, packId: 'pB', packOffset: 160 },
  ])
})

test('parseCacheFrames rejects overlap, out-of-order and malformed entries', () => {
  assert.ok(parseCacheFrames([{ start: 1, end: 2, packId: 'p', packOffset: 0 }]))
  assert.equal(
    parseCacheFrames([
      { start: 2, end: 3, packId: 'p', packOffset: 0 },
      { start: 1, end: 2, packId: 'p', packOffset: 0 },
    ]),
    undefined,
  )
  assert.equal(
    parseCacheFrames([
      { start: 1, end: 5, packId: 'p', packOffset: 0 },
      { start: 4, end: 8, packId: 'p', packOffset: 4 },
    ]),
    undefined,
  )
  assert.equal(parseCacheFrames([{ start: 1, end: 2 }]), undefined)
})
