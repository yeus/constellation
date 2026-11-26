import assert from 'node:assert/strict'
import test from 'node:test'

import { oklabDistance, randomVividPeerColor } from './peerColor.ts'

const seeded = (seed: number): (() => number) => {
  let value = seed >>> 0
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0
    return value / 2 ** 32
  }
}

test('samples vivid, bright colors within displayable sRGB', () => {
  const random = seeded(418)
  const colors = Array.from({ length: 120 }, () => randomVividPeerColor([], random))
  for (const color of colors) {
    assert.match(color, /^#[0-9a-f]{6}$/)
    const channels = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    assert.ok(Math.max(...channels) - Math.min(...channels) >= 70, color)
  }
  assert.ok(new Set(colors).size > 110)
})

test('greedily separates successive peer colors in OKLab space', () => {
  const random = seeded(22)
  const colors: string[] = []
  for (let i = 0; i < 8; i += 1) colors.push(randomVividPeerColor(colors, random))
  for (let i = 0; i < colors.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      assert.ok(oklabDistance(colors[i]!, colors[j]!) > 0.09, colors.join(', '))
    }
  }
})

test('deterministic with injected randomness; ignores malformed legacy colors', () => {
  const existing = ['not-a-color', '#438ec9', '#8a6fc9']
  assert.equal(
    randomVividPeerColor(existing, seeded(12)),
    randomVividPeerColor(existing, seeded(12)),
  )
})
