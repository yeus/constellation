import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const targets = [
  [Object, 'hasOwn'],
  [Promise, 'any'],
  [Promise, 'allSettled'],
  [Promise, 'withResolvers'],
  [Array.prototype, 'at'],
  [Array.prototype, 'findLast'],
  [String.prototype, 'at'],
  [String.prototype, 'replaceAll'],
  [AbortSignal, 'timeout'],
  [AbortSignal.prototype, 'throwIfAborted'],
  [crypto, 'randomUUID'],
  [globalThis, 'AggregateError'],
]

test('legacy compatibility layer supplies the APIs used by the Android 10 bundle', async () => {
  const descriptors = targets.map(([owner, property]) => [
    owner,
    property,
    Object.getOwnPropertyDescriptor(owner, property),
  ])
  try {
    for (const [owner, property] of targets) {
      Object.defineProperty(owner, property, {
        value: undefined,
        writable: true,
        configurable: true,
      })
    }
    await import(`${pathToFileURL('public/legacy-compat.js').href}?legacy-test`)

    assert.equal(Object.hasOwn({ value: 1 }, 'value'), true)
    assert.equal(
      await Promise.any([Promise.reject(new Error('first')), Promise.resolve('ok')]),
      'ok',
    )
    await assert.rejects(
      () => Promise.any([]),
      (error) => error?.name === 'AggregateError',
    )
    assert.deepEqual(await Promise.allSettled([Promise.resolve(1), Promise.reject('no')]), [
      { status: 'fulfilled', value: 1 },
      { status: 'rejected', reason: 'no' },
    ])
    const deferred = Promise.withResolvers()
    deferred.resolve('ready')
    assert.equal(await deferred.promise, 'ready')
    assert.equal([1, 2, 3].at(-1), 3)
    assert.equal('abc'.at(-1), 'c')
    assert.equal(
      [1, 2, 3, 4].findLast((value) => value % 2 === 1),
      3,
    )
    assert.equal('a-b-a'.replaceAll('a', 'x'), 'x-b-x')
    assert.equal(typeof AbortSignal.timeout(1).addEventListener, 'function')
    assert.match(
      crypto.randomUUID(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const controller = new AbortController()
    assert.doesNotThrow(() => controller.signal.throwIfAborted())
    controller.abort(new Error('stopped'))
    assert.throws(() => controller.signal.throwIfAborted(), /stopped|abort/i)
  } finally {
    for (const [owner, property, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(owner, property, descriptor)
      else Reflect.deleteProperty(owner, property)
    }
  }
})
