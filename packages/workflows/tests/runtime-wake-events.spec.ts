import { describe, expect, it } from 'vitest'

import type { ClaimedAttempt } from '../src/runtime/commands.ts'
import type { AttemptExecutor } from '../src/runtime/executors.ts'
import { runWithAttemptHeartbeat } from '../src/runtime/worker/heartbeat.ts'
import { drainWorkerPool, serveWorkerPool } from '../src/runtime/worker/loop.ts'

const LONG_DELAY_MS = 30_000

describe('workflow wake events', () => {
  it('short-circuits the worker loop idle delay on wake', async () => {
    const abort = new AbortController()
    let wake: () => void = () => {}
    let claims = 0
    const started = Date.now()

    const result = await serveWorkerPool(
      {
        workerId: 'wake-loop',
        idleDelayMs: LONG_DELAY_MS,
        signal: abort.signal,
        onWake: (listener) => {
          wake = listener
          return () => {}
        },
      },
      {
        async claim() {
          claims += 1
          if (claims === 1) setTimeout(() => wake(), 20)
          else abort.abort()
          return null
        },
        async execute() {
          return true
        },
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

    await drainWorkerPool(
      {
        workerId: 'wake-latch',
        idleDelayMs: LONG_DELAY_MS,
        onWake: (listener) => {
          wake = listener
          return () => {}
        },
      },
      {
        async claim() {
          claims += 1
          // fires before the idle sleep starts — must still be observed
          if (claims === 1) wake()
          return null
        },
        async execute() {
          return true
        },
      },
    )

    expect(claims).toBe(2)
    expect(Date.now() - started).toBeLessThan(LONG_DELAY_MS)
  })

  it('keeps idle concurrency available while a sibling claim is running', async () => {
    let wake: () => void = () => {}
    let fastQueued = false
    let fastStarted = false
    let releaseSlow!: () => void
    let markSlowStarted!: () => void
    let markIdleClaimed!: () => void
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve
    })
    const idleClaimed = new Promise<void>((resolve) => {
      markIdleClaimed = resolve
    })
    let claims = 0

    const running = drainWorkerPool<'slow' | 'fast'>(
      {
        workerId: 'wake-concurrency',
        concurrency: 2,
        idleDelayMs: LONG_DELAY_MS,
        onWake: (listener) => {
          wake = listener
          return () => {}
        },
      },
      {
        async claim() {
          claims += 1
          if (claims === 1) return 'slow'
          if (fastQueued) {
            fastQueued = false
            return 'fast'
          }
          markIdleClaimed()
          return null
        },
        async execute(claimed) {
          if (claimed === 'slow') {
            markSlowStarted()
            await slow
          } else {
            fastStarted = true
          }
          return true
        },
      },
    )

    await Promise.all([slowStarted, idleClaimed])
    fastQueued = true
    wake()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const startedBeforeSlowFinished = fastStarted

    releaseSlow()
    const result = await running

    expect(startedBeforeSlowFinished).toBe(true)
    expect(result.processed).toBe(2)
  })

  it('polls idle capacity while a sibling execution is active', async () => {
    let slowClaimed = false
    let fastQueued = false
    let fastStarted = false
    let releaseSlow!: () => void
    let markSlowStarted!: () => void
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve
    })

    const running = drainWorkerPool<'slow' | 'fast'>(
      {
        workerId: 'poll-active-capacity',
        concurrency: 2,
        idleDelayMs: 2,
      },
      {
        async claim() {
          if (!slowClaimed) {
            slowClaimed = true
            return 'slow'
          }
          if (!fastQueued) return null
          fastQueued = false
          return 'fast'
        },
        async execute(claimed) {
          if (claimed === 'slow') {
            markSlowStarted()
            await slow
          } else {
            fastStarted = true
          }
          return true
        },
      },
    )

    await slowStarted
    fastQueued = true
    await new Promise((resolve) => setTimeout(resolve, 20))
    const startedBeforeSlowFinished = fastStarted
    releaseSlow()

    const result = await running
    expect(startedBeforeSlowFinished).toBe(true)
    expect(result.processed).toBe(2)
  })

  it('does not treat an unprocessed claim as an empty queue', async () => {
    const queued = ['skip', 'process']
    const executed: string[] = []

    const result = await drainWorkerPool(
      { workerId: 'claim-outcomes' },
      {
        async claim() {
          return queued.shift() ?? null
        },
        async execute(claimed) {
          executed.push(claimed)
          return claimed === 'process'
        },
      },
    )

    expect(executed).toStrictEqual(['skip', 'process'])
    expect(result.processed).toBe(1)
  })

  it('runs drain maintenance once and claims work it creates', async () => {
    let queued = false
    let maintenanceRuns = 0

    const result = await drainWorkerPool(
      {
        workerId: 'drain-maintenance',
        maintenance: [
          {
            everyMs: 0,
            async run() {
              maintenanceRuns += 1
              queued = true
            },
          },
        ],
      },
      {
        async claim() {
          if (!queued) return null
          queued = false
          return 'created-by-maintenance'
        },
        async execute() {
          return true
        },
      },
    )

    expect(maintenanceRuns).toBe(1)
    expect(result.processed).toBe(1)
  })

  it('fills freed capacity without exceeding the concurrency limit', async () => {
    const queued = [1, 2, 3, 4, 5]
    let active = 0
    let maxActive = 0

    const result = await drainWorkerPool(
      { workerId: 'concurrency-bound', concurrency: 2 },
      {
        async claim() {
          return queued.shift() ?? null
        },
        async execute() {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
          return true
        },
      },
    )

    expect(maxActive).toBe(2)
    expect(result.processed).toBe(5)
  })

  it('lets active siblings finish after an execution fails', async () => {
    const queued = ['bad', 'slow']
    let markSlowStarted!: () => void
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve
    })
    let slowFinished = false
    let slowWasAborted = false

    const running = drainWorkerPool(
      { workerId: 'execution-failure', concurrency: 2 },
      {
        async claim() {
          return queued.shift() ?? null
        },
        async execute(claimed, signal) {
          if (claimed === 'bad') {
            await slowStarted
            throw new Error('execution failed')
          }
          markSlowStarted()
          await new Promise((resolve) => setTimeout(resolve, 10))
          slowWasAborted = signal.aborted
          slowFinished = true
          return true
        },
      },
    )

    await expect(running).rejects.toThrow('execution failed')
    expect(slowFinished).toBe(true)
    expect(slowWasAborted).toBe(false)
  })

  it('polls as a fallback when no wake source is available', async () => {
    const abort = new AbortController()
    let queued = false
    setTimeout(() => {
      queued = true
    }, 10)

    const result = await serveWorkerPool(
      {
        workerId: 'poll-fallback',
        signal: abort.signal,
        idleDelayMs: 2,
      },
      {
        async claim() {
          if (!queued) return null
          queued = false
          return 'polled'
        },
        async execute() {
          abort.abort()
          return true
        },
      },
    )

    expect(result.processed).toBe(1)
  })

  it('aborts and awaits active executions during service shutdown', async () => {
    const abort = new AbortController()
    let claimed = false
    let releaseExecution!: () => void
    let markExecutionStarted!: () => void
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve
    })
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve
    })
    let executionSawAbort = false
    let settled = false

    const running = serveWorkerPool(
      { workerId: 'shutdown', signal: abort.signal },
      {
        async claim() {
          if (claimed) return null
          claimed = true
          return 'active'
        },
        async execute(_claimed, signal) {
          markExecutionStarted()
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                executionSawAbort = true
                resolve()
              },
              { once: true },
            )
          })
          await executionReleased
          return false
        },
      },
    ).finally(() => {
      settled = true
    })

    await executionStarted
    abort.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(executionSawAbort).toBe(true)
    expect(settled).toBe(false)

    releaseExecution()
    await running
    expect(settled).toBe(true)
  })

  it('surfaces unexpected execution failures during shutdown', async () => {
    const abort = new AbortController()
    let claimed = false
    let markExecutionStarted!: () => void
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve
    })

    const running = serveWorkerPool(
      { workerId: 'shutdown-failure', signal: abort.signal },
      {
        async claim() {
          if (claimed) return null
          claimed = true
          return 'active'
        },
        async execute(_claimed, signal) {
          markExecutionStarted()
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          throw new Error('shutdown write failed')
        },
      },
    )

    await executionStarted
    abort.abort()
    await expect(running).rejects.toThrow('shutdown write failed')
  })

  it('rejects invalid concurrency before subscribing to wakes', async () => {
    let subscribed = false

    await expect(
      drainWorkerPool(
        {
          workerId: 'invalid-concurrency',
          concurrency: 0,
          onWake() {
            subscribed = true
            return () => {}
          },
        },
        {
          async claim() {
            return null
          },
          async execute() {
            return false
          },
        },
      ),
    ).rejects.toThrow('Concurrency must be a positive integer')
    expect(subscribed).toBe(false)
  })

  it('runs periodic work independently of claims and preserves its cadence', async () => {
    const abort = new AbortController()
    let claimed = false
    let maintenanceRuns = 0
    let markExecutionStarted!: () => void
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve
    })

    const running = serveWorkerPool(
      {
        workerId: 'periodic-worker',
        signal: abort.signal,
        idleDelayMs: 1,
        maintenance: [
          {
            everyMs: LONG_DELAY_MS,
            async run() {
              maintenanceRuns += 1
            },
          },
        ],
      },
      {
        async claim() {
          if (claimed) return null
          claimed = true
          return 'slow'
        },
        async execute(_claimed, signal) {
          markExecutionStarted()
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return false
        },
      },
    )

    await executionStarted
    await new Promise((resolve) => setTimeout(resolve, 20))
    abort.abort()
    await running

    expect(maintenanceRuns).toBe(1)
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

  it('latches a cancellation wake that fires while a heartbeat is in flight', async () => {
    const claimed = {
      id: 'command-2',
      leaseToken: 'lease-2',
      command: {
        kind: 'activityAttempt',
        workflowName: 'wf',
        activityName: 'act',
        runId: 'run-2',
        nodeName: 'node-2',
        childKey: 'self',
        attemptId: 'attempt-2',
        leaseToken: 'lease-2',
        input: {},
      },
    } as unknown as ClaimedAttempt

    const heartbeats: Array<(result: { runStatus: string }) => void> = []
    const attemptExecutor = {
      heartbeat: () =>
        new Promise<{ runStatus: string }>((resolve) => {
          heartbeats.push(resolve)
        }),
    } as unknown as AttemptExecutor

    let cancellationWake: (() => void) | undefined
    const work = runWithAttemptHeartbeat(
      {
        attemptExecutor,
        claimed,
        leaseMs: LONG_DELAY_MS * 3,
        wakeEvents: {
          onCancellation: (_runId, listener) => {
            cancellationWake = listener
            return () => {}
          },
        },
      },
      () => new Promise<never>(() => {}),
    )

    // first wake starts a heartbeat whose snapshot predates the cancellation
    cancellationWake!()
    expect(heartbeats.length).toBe(1)
    // cancellation commits and a second wake fires while it is in flight
    cancellationWake!()
    expect(heartbeats.length).toBe(1)
    heartbeats[0]!({ runStatus: 'running' })
    // the latched wake must trigger a follow-up check without waiting for
    // the interval
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(heartbeats.length).toBe(2)
    heartbeats[1]!({ runStatus: 'cancelling' })

    await expect(work).rejects.toThrow('observed cancellation')
  })
})
