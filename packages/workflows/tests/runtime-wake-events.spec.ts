import { describe, expect, it } from 'vitest'

import type { ClaimedAttempt } from '../src/runtime/commands.ts'
import type { AttemptExecutor } from '../src/runtime/executors.ts'
import { runWithAttemptHeartbeat } from '../src/runtime/worker/heartbeat.ts'
import { runWorkerLoop } from '../src/runtime/worker/loop.ts'

const LONG_DELAY_MS = 30_000

describe('workflow wake events', () => {
  it('short-circuits the worker loop idle delay on wake', async () => {
    let wake: () => void = () => {}
    let claims = 0
    const started = Date.now()

    const result = await runWorkerLoop(
      {
        workerId: 'wake-loop',
        maxIdleClaims: 2,
        idleDelayMs: LONG_DELAY_MS,
        onWake: (listener) => {
          wake = listener
          return () => {}
        },
      },
      async () => {
        claims += 1
        if (claims === 1) setTimeout(() => wake(), 20)
        return false
      },
    )

    expect(result.processed).toBe(0)
    expect(claims).toBe(2)
    expect(Date.now() - started).toBeLessThan(LONG_DELAY_MS)
  })

  it('latches a wake that fires while a claim is in flight', async () => {
    let wake: () => void = () => {}
    let claims = 0
    const started = Date.now()

    await runWorkerLoop(
      {
        workerId: 'wake-latch',
        maxIdleClaims: 2,
        idleDelayMs: LONG_DELAY_MS,
        onWake: (listener) => {
          wake = listener
          return () => {}
        },
      },
      async () => {
        claims += 1
        // fires before the idle sleep starts — must still be observed
        if (claims === 1) wake()
        return false
      },
    )

    expect(claims).toBe(2)
    expect(Date.now() - started).toBeLessThan(LONG_DELAY_MS)
  })

  it('runs the heartbeat check immediately on a cancellation wake', async () => {
    const claimed = {
      id: 'command-1',
      leaseToken: 'lease-1',
      command: {
        kind: 'activityAttempt',
        workflowName: 'wf',
        activityName: 'act',
        runId: 'run-1',
        nodeName: 'node-1',
        childKey: 'self',
        attemptId: 'attempt-1',
        leaseToken: 'lease-1',
        input: {},
      },
    } as unknown as ClaimedAttempt

    let cancelling = false
    const attemptExecutor = {
      heartbeat: async () => ({
        runStatus: cancelling ? 'cancelling' : 'running',
      }),
    } as unknown as AttemptExecutor

    let cancellationWake: (() => void) | undefined
    const work = runWithAttemptHeartbeat(
      {
        attemptExecutor,
        claimed,
        leaseMs: LONG_DELAY_MS * 3, // heartbeat interval far beyond test timeout
        wakeEvents: {
          onCancellation: (runId, listener) => {
            expect(runId).toBe('run-1')
            cancellationWake = listener
            return () => {}
          },
        },
      },
      () => new Promise<never>(() => {}),
    )

    expect(cancellationWake).toBeDefined()
    cancelling = true
    cancellationWake!()
    await expect(work).rejects.toThrow('observed cancellation')
  })
})
