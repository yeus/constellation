import assert from 'node:assert/strict'
import test from 'node:test'

import { peerInitials } from './peerAvatar.ts'

test('uses one or two initials from the displayed peer name', () => {
  assert.equal(peerInitials('Ada Lovelace'), 'AL')
  assert.equal(peerInitials('Luna'), 'LU')
  assert.equal(peerInitials('  Ada   Byron King  '), 'AB')
  assert.equal(peerInitials('ada-lovelace'), 'AL')
  assert.equal(peerInitials('A'), 'A')
})

test('supports non-Latin names and a neutral unnamed fallback', () => {
  assert.equal(peerInitials('李 雷'), '李雷')
  assert.equal(peerInitials(''), '•')
})
