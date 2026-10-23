export interface FollowOwnershipEffects {
  /** Close active viewer streams without revoking any share capability. */
  readonly suspendActivity: () => Promise<void>
  readonly resumeActivity: () => Promise<void>
  /** Native activation MUST verify persistent ownership before returning. */
  readonly startService: (generation: number) => Promise<void>
  /** Must durably relinquish native ownership and flush state before returning. */
  readonly stopService: (generation: number) => Promise<void>
}

export type FollowOwner = 'activity' | 'service'

export const createFollowOwnership = (
  effects: FollowOwnershipEffects,
  initial: { owner: FollowOwner; generation: number } = { owner: 'activity', generation: 0 },
) => {
  let { owner, generation } = initial
  let pending: Promise<void> = Promise.resolve()

  const transition = (target: FollowOwner): Promise<void> => {
    const operation = pending.then(async () => {
      if (target === owner) return
      const nextGeneration = target === 'service' ? generation + 1 : generation
      if (target === 'service') {
        try {
          await effects.suspendActivity()
        } catch (error) {
          await effects.resumeActivity()
          throw error
        }
        try {
          await effects.startService(nextGeneration)
          generation = nextGeneration
          owner = 'service'
        } catch (error) {
          // A failed native start may have partially acquired the lease.
          // Do not restore an Activity viewer until the native side confirms release.
          generation = nextGeneration
          await effects.stopService(nextGeneration)
          await effects.resumeActivity()
          throw error
        }
      } else {
        // Service release is the hard ordering barrier: never start two identical viewers.
        await effects.stopService(nextGeneration)
        owner = 'activity'
        await effects.resumeActivity()
      }
    })
    pending = operation.catch(() => undefined)
    return operation
  }

  return {
    transition,
    snapshot: () => ({ owner, generation }),
  }
}
