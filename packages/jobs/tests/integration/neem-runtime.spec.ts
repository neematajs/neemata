import type { NeemRuntimePlannerContext } from '@nmtjs/neem'
import { createLogger } from '@nmtjs/core'
import { createJob } from '@nmtjs/jobs'
import { createJobsRuntime, defineJobsPlanner } from '@nmtjs/jobs/neem'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

describe('@nmtjs/jobs Neem runtime helpers', () => {
  it('declares a jobs runtime with package-owned host and caller worker entry', () => {
    const defineRuntime = createJobsRuntime()
    const runtime = defineRuntime({
      name: 'jobs',
      planner: './jobs.planner.ts',
      worker: { entry: './jobs.worker.ts' },
    })

    expect(runtime).toMatchObject({
      name: 'jobs',
      planner: './jobs.planner.ts',
      host: { entry: '@nmtjs/jobs/neem/host' },
      worker: { entry: './jobs.worker.ts' },
    })
  })

  it('plans one worker group per configured pool', async () => {
    const fastJob = createJob({
      name: 'fast-job',
      pool: 'fast',
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
    }).return(({ input }) => input)
    const slowJob = createJob({
      name: 'slow-job',
      pool: 'slow',
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
    }).return(({ input }) => input)
    const factory = () => ({
      client: () => {
        throw new Error('planner must not open jobs client')
      },
      pools: { fast: { threads: 2, jobs: 4 }, slow: { threads: 1, jobs: 1 } },
      jobs: () => [fastJob, slowJob],
    })
    const planner = defineJobsPlanner(factory)

    const plan = await planner(plannerContext)

    expect(plan.workers).toEqual({
      fast: [{ poolName: 'fast' }, { poolName: 'fast' }],
      slow: [{ poolName: 'slow' }],
    })
    expect(plan.options).toBe(factory)
  })
})

const plannerContext = {
  mode: 'development',
  name: 'jobs',
  logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
} satisfies NeemRuntimePlannerContext
