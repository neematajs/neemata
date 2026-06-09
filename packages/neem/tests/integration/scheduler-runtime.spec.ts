import type { SchedulerConfig } from '@nmtjs/scheduler'
import { createLogger } from '@nmtjs/core'
import {
  createSchedulerRuntime,
  defineSchedulerPlanner,
} from '@nmtjs/scheduler/neem'
import createSchedulerHost from '@nmtjs/scheduler/neem/host'
import { describe, expect, it } from 'vitest'

describe('scheduler Neem runtime helper', () => {
  it('defines scheduler as a host-only runtime with a planner', () => {
    const defineRuntime = createSchedulerRuntime()
    const runtime = defineRuntime({ planner: './scheduler.planner.ts' })

    expect(runtime.worker).toBeUndefined()
    expect(runtime.host?.entry).toBe('@nmtjs/scheduler/neem/host')
    expect(runtime.planner).toBe('./scheduler.planner.ts')
  })

  it('normalizes scheduler planner output to host-local options', async () => {
    const factory = () => schedulerConfig
    const planner = defineSchedulerPlanner(factory)

    expect(planner()).toEqual({ workers: [], options: factory })
  })

  it('requires scheduler planner options in the host', async () => {
    expect(() =>
      createSchedulerHost({
        mode: 'development',
        name: 'scheduler',
        options: undefined,
        logger: testLogger,
        threads: [],
      }),
    ).toThrow('Scheduler runtime planner options are missing')
  })
})

const schedulerConfig: SchedulerConfig = {
  client: () => {
    throw new Error('not used')
  },
  jobs: () => [],
  schedules: () => [],
}

const testLogger = createLogger({ pinoOptions: { enabled: false } }, 'test')
