import type { NeemRuntimePlannerContext } from '@nmtjs/neem'
import { createLogger } from '@nmtjs/core'
import { createJob } from '@nmtjs/jobs'
import {
  createSchedulerRuntime,
  defineSchedulerPlanner,
} from '@nmtjs/scheduler/neem'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

describe('@nmtjs/scheduler Neem runtime helpers', () => {
  it('declares a host-only scheduler runtime', () => {
    const defineRuntime = createSchedulerRuntime()
    const runtime = defineRuntime({
      name: 'scheduler',
      planner: './scheduler.planner.ts',
    })

    expect(runtime).toMatchObject({
      name: 'scheduler',
      planner: './scheduler.planner.ts',
      host: { entry: '@nmtjs/scheduler/neem/host' },
    })
    expect(runtime.worker).toBeUndefined()
  })

  it('plans zero workers and carries scheduler config factory to the host', async () => {
    const job = createJob({
      name: 'scheduled-job',
      pool: 'default',
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
    }).return(({ input }) => input)
    const factory = () => ({
      client: () => {
        throw new Error('planner must not open scheduler client')
      },
      jobs: () => [job],
      schedules: () => [
        {
          id: 'tick',
          job,
          data: { value: 'scheduled' },
          repeat: { every: 1000, limit: 1 },
        },
      ],
    })
    const planner = defineSchedulerPlanner(factory)

    const plan = await planner(plannerContext)

    expect(plan.workers).toEqual([])
    expect(plan.options).toBe(factory)
  })
})

const plannerContext = {
  mode: 'development',
  name: 'scheduler',
  logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
} satisfies NeemRuntimePlannerContext
