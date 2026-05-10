import EventEmitter from 'node:events'

import type { Logger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManagedWorkerConfig } from '../src/runtime/server/managed-worker.ts'
import type { ManagedWorkerFactory } from '../src/runtime/server/worker-pool.ts'
import { createJob, defineServer } from '../src/runtime/index.ts'
import { DevErrorPolicy } from '../src/runtime/server/error-policy.ts'
import { ApplicationServerJobs } from '../src/runtime/server/jobs.ts'
import { WorkerPool } from '../src/runtime/server/worker-pool.ts'

const bullmqState = vi.hoisted(() => ({
  workers: [] as Array<{
    queueName: string
    processor: unknown
    options: { concurrency?: number }
  }>,
}))

vi.mock('bullmq', () => {
  class Worker {
    constructor(
      queueName: string,
      processor: unknown,
      options: { concurrency?: number },
    ) {
      bullmqState.workers.push({ queueName, processor, options })
    }

    async close() {}
  }

  return {
    UnrecoverableError: class UnrecoverableError extends Error {},
    Worker,
  }
})

const logger = {
  child: () => logger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  trace: () => {},
  error: () => {},
} as unknown as Logger

const workerFactory: ManagedWorkerFactory = (config: ManagedWorkerConfig) => {
  const worker = new EventEmitter() as EventEmitter & {
    config: ManagedWorkerConfig
    context: { consecutiveFailures: number; totalFailures: number }
    currentState: 'ready'
    isHealthy: boolean
    start: () => Promise<void>
    stop: () => Promise<void>
    run: () => Promise<never>
    resetFailureCount: () => void
  }

  worker.config = config
  worker.context = { consecutiveFailures: 0, totalFailures: 0 }
  worker.currentState = 'ready'
  worker.isHealthy = true
  worker.start = async () => {}
  worker.stop = async () => {}
  worker.run = async () => {
    throw new Error('not used in this test')
  }
  worker.resetFailureCount = () => {}

  return worker as any
}

function createTestJob(name: string, pool: string) {
  return createJob({
    name,
    pool,
    input: t.object({}),
    output: t.object({}),
  }).return()
}

function createServerJobs(params: {
  jobs: ReturnType<typeof createTestJob>[]
  pools: Record<string, { threads: number; jobs: number }>
}) {
  const serverConfig = defineServer({
    logger: { pinoOptions: { enabled: false } },
    applications: {},
    jobs: params,
  })

  return new ApplicationServerJobs({
    logger,
    serverConfig,
    workerConfig: { path: '/virtual/worker.ts', workerData: {} },
    store: {} as any,
    errorPolicy: DevErrorPolicy,
    workerFactory,
    poolFactory: (config, policy, factory, poolLogger) =>
      new WorkerPool(config, policy, factory, poolLogger),
  })
}

describe('server jobs pools', () => {
  beforeEach(() => {
    bullmqState.workers.length = 0
  })

  it('starts custom pools used by active jobs', async () => {
    const jobs = createServerJobs({
      jobs: [
        createTestJob('test-job-1', 'test-pool-1'),
        createTestJob('test-job-2', 'test-pool-1'),
      ],
      pools: { 'test-pool-1': { threads: 2, jobs: 5 } },
    })

    await jobs.start()

    expect(jobs.getPool('test-pool-1')?.workerCount).toBe(2)
    expect(bullmqState.workers).toHaveLength(2)
    expect(
      bullmqState.workers.map((worker) => worker.options.concurrency),
    ).toEqual([5, 5])

    await jobs.stop()
  })

  it('throws when an active job references a missing pool config', async () => {
    const jobs = createServerJobs({
      jobs: [createTestJob('test-job-1', 'test-pool-1')],
      pools: {},
    })

    await expect(jobs.start()).rejects.toThrow(
      'Invalid jobs pool configuration: missing pool config for jobs: test-job-1 -> test-pool-1',
    )
    expect(bullmqState.workers).toHaveLength(0)
  })

  it('ignores pool configs unused by active jobs', async () => {
    const jobs = createServerJobs({
      jobs: [createTestJob('test-job-1', 'test-pool-1')],
      pools: {
        'test-pool-1': { threads: 1, jobs: 1 },
        'test-pool-2': { threads: 1, jobs: 1 },
      },
    })

    await jobs.start()

    expect(jobs.getPool('test-pool-1')?.workerCount).toBe(1)
    expect(jobs.getPool('test-pool-2')).toBeUndefined()

    await jobs.stop()
  })
})
