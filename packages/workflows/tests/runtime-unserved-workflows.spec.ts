import { afterEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runWorkflowWorker,
  serveWorkflowWorker,
  type UnservedWorkflowWarning,
} from '../src/runtime/index.ts'

// Maintenance sleeps on node:timers/promises, which fake timers do not reach.
// Routing it through the global timer puts the check cadence on the test clock.
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>()
  return {
    ...actual,
    setTimeout: <T>(
      delay: number,
      value?: T,
      options?: { readonly signal?: AbortSignal },
    ) =>
      new Promise<T | undefined>((resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted) return reject(signal.reason)
        const onAbort = () => {
          clearTimeout(timer)
          reject(signal!.reason)
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        }, delay)
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
  }
})

const empty = z.object({})
const served = defineWorkflow({
  name: 'unserved.served',
  input: empty,
  output: empty,
}).build()
const unserved = defineWorkflow({
  name: 'unserved.elsewhere',
  input: empty,
  output: empty,
}).build()
const servedImplementation = implementWorkflow(served, { pool: 'test' }).finish(
  () => ({}),
)

describe('unserved workflow warnings', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('warns once per check about runs no coordinator claims', async () => {
    vi.useFakeTimers()
    const startedAt = Date.parse('2026-01-01T00:00:00.000Z')
    vi.setSystemTime(startedAt)
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    await client.start(unserved, {})
    const servedRun = await client.start(served, {})
    const warnings: UnservedWorkflowWarning[] = []
    const abort = new AbortController()

    const serving = serveWorkflowWorker({
      ...runtime,
      workflows: [servedImplementation],
      workerId: 'coordinator',
      signal: abort.signal,
      onWarning: (warning) => warnings.push(warning),
      unservedWorkflows: { everyMs: 60_000, afterMs: 30_000 },
    })

    // The first check runs at startup, before the run is old enough to count.
    await vi.advanceTimersByTimeAsync(59_999)
    expect((await client.get(servedRun.id))?.run.status).toBe('completed')
    expect(warnings).toStrictEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(warnings).toStrictEqual([
      {
        workflowName: unserved.name,
        count: 1,
        oldestClaimableAt: startedAt,
        message: expect.stringContaining(`[${unserved.name}]`),
      },
    ])

    // Hundreds of idle polls later, the window has not produced another one.
    await vi.advanceTimersByTimeAsync(59_999)
    expect(warnings).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(warnings).toHaveLength(2)
    expect(warnings[1]).toMatchObject({ workflowName: unserved.name })

    abort.abort()
    await serving
  })

  it('resumes each check where the previous page ended', async () => {
    vi.useFakeTimers()
    const runtime = createInMemoryWorkflowRuntime()
    const cursors: (string | undefined)[] = []
    const pages = ['second', undefined, 'second']
    const abort = new AbortController()

    const serving = serveWorkflowWorker({
      ...runtime,
      runCoordinationExecutor: {
        ...runtime.runCoordinationExecutor,
        listUnserved: async (query) => {
          cursors.push(query.cursor)
          const cursor = pages.shift()
          return cursor === undefined
            ? { workflows: [] }
            : { workflows: [], cursor }
        },
      },
      workflows: [servedImplementation],
      workerId: 'coordinator',
      signal: abort.signal,
      onWarning: () => {},
      unservedWorkflows: { everyMs: 60_000 },
    })
    await vi.advanceTimersByTimeAsync(120_000)
    abort.abort()
    await serving

    // A finished pass over the queue starts the next one from the beginning.
    expect(cursors).toStrictEqual([undefined, 'second', undefined])
  })

  it('never checks from a one-shot drain', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'))
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    await client.start(unserved, {})
    vi.setSystemTime(Date.parse('2026-01-02T00:00:00.000Z'))
    let checks = 0

    // Each drain would start over at the first page, which could hold only
    // other workflows forever.
    for (let drain = 0; drain < 3; drain++) {
      await runWorkflowWorker({
        ...runtime,
        runCoordinationExecutor: {
          ...runtime.runCoordinationExecutor,
          listUnserved: async (query) => {
            checks += 1
            return await runtime.runCoordinationExecutor.listUnserved(query)
          },
        },
        workflows: [servedImplementation],
        workerId: 'coordinator',
        onWarning: () => {},
        unservedWorkflows: { everyMs: 0, afterMs: 0 },
      })
    }

    expect(checks).toBe(0)
  })
})
