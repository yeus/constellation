import assert from 'node:assert/strict'
import test from 'node:test'
import { createFollowOwnership } from './followOwnership.ts'

test('handoff serializes both directions and never overlaps active viewer owners', async () => {
  let activity = true
  let service = false
  const events: string[] = []
  const control = createFollowOwnership({
    suspendActivity: async () => {
      assert.equal(service, false)
      activity = false
      events.push('pause')
    },
    resumeActivity: async () => {
      assert.equal(service, false)
      activity = true
      events.push('resume')
    },
    startService: async (generation) => {
      assert.equal(activity, false)
      service = true
      events.push(`start:${generation}`)
    },
    stopService: async (generation) => {
      service = false
      events.push(`stop:${generation}`)
    },
  })
  await Promise.all([
    control.transition('service'),
    control.transition('service'),
    control.transition('activity'),
  ])
  assert.deepEqual(events, ['pause', 'start:1', 'stop:1', 'resume'])
  assert.deepEqual(control.snapshot(), { owner: 'activity', generation: 1 })
  assert.equal(activity, true)
})

test('a failed native startup fences the foreground viewer until native cleanup', async () => {
  const events: string[] = []
  const control = createFollowOwnership({
    suspendActivity: async () => {
      events.push('pause')
    },
    startService: async () => {
      events.push('native-start')
      throw new Error('start failed')
    },
    stopService: async () => {
      events.push('native-stop')
    },
    resumeActivity: async () => {
      events.push('resume')
    },
  })
  await assert.rejects(control.transition('service'), /start failed/)
  assert.deepEqual(events, ['pause', 'native-start', 'native-stop', 'resume'])
  assert.deepEqual(control.snapshot(), { owner: 'activity', generation: 1 })
})

test('failed native release must not reactivate a duplicate viewer', async () => {
  let resumes = 0
  const control = createFollowOwnership({
    suspendActivity: async () => undefined,
    startService: async () => undefined,
    stopService: async () => {
      throw new Error('native lease still held')
    },
    resumeActivity: async () => {
      resumes++
    },
  })
  await control.transition('service')
  await assert.rejects(control.transition('activity'), /native lease still held/)
  assert.equal(resumes, 0)
  assert.equal(control.snapshot().owner, 'service')
})

test('restored native generation is reused for release and incremented only for next acquisition', async () => {
  const generations: string[] = []
  const control = createFollowOwnership(
    {
      suspendActivity: async () => undefined,
      resumeActivity: async () => undefined,
      startService: async (g) => {
        generations.push(`start:${g}`)
      },
      stopService: async (g) => {
        generations.push(`stop:${g}`)
      },
    },
    { owner: 'service', generation: 9 },
  )
  await control.transition('activity')
  await control.transition('service')
  assert.deepEqual(generations, ['stop:9', 'start:10'])
})
