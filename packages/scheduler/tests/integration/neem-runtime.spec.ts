import { createJob } from '@nmtjs/jobs'
import {
  defineSchedulerPlanner,
  defineSchedulerRuntime,
} from '@nmtjs/scheduler/neem'
import { describe, expect, it } from 'vitest'

import { t } from '../../../type/src/index.ts'

describe('@nmtjs/scheduler Neem runtime helpers', () => {
  it('declares a host-only scheduler runtime', () => {
    const runtime = defineSchedulerRuntime({
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

    const plan = await planner()

    expect(plan.workers).toEqual([])
    expect(plan.options).toBe(factory)
  })
})
