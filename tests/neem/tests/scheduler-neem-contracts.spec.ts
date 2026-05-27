import type { JobsClient } from '@nmtjs/jobs'
import { createJob } from '@nmtjs/jobs'
import {
  defineScheduler,
  getOwnedSchedulerId,
  resolveSchedulerConfig,
} from '@nmtjs/scheduler'
import { defineSchedulerRuntime } from '@nmtjs/scheduler/neem'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('@nmtjs/scheduler Neem contracts', () => {
  it('defines scheduler config from async jobs and schedule factories', async () => {
    const calls: unknown[] = []
    const job = createJob({
      name: 'scheduled-import-users',
      pool: 'default',
      input: t.object({ tenant: t.string() }),
      output: t.object({}),
    }).return()

    const config = defineScheduler({
      client: createClientConfig(),
      jobs: async () => {
        calls.push({ type: 'jobs-factory' })
        return [job]
      },
      schedules: async () => {
        calls.push({ type: 'schedules-factory' })
        return [
          {
            id: 'import-users-hourly',
            job,
            data: { tenant: 'acme' },
            repeat: { every: 60 * 60 * 1000 },
          },
        ]
      },
      handoff: 'cutover',
    })

    const resolved = await resolveSchedulerConfig(config)

    expect(resolved.jobs).toEqual([job])
    expect(resolved.schedules).toHaveLength(1)
    expect(resolved.handoff).toBe('cutover')
    expect(calls).toEqual([
      { type: 'jobs-factory' },
      { type: 'schedules-factory' },
    ])
    expect(getOwnedSchedulerId('scheduler', 'import-users-hourly')).toBe(
      'scheduler:import-users-hourly',
    )
  })

  it('keeps scheduler runtime helper typed as Neem runtime config', () => {
    const runtime = defineSchedulerRuntime({ config: './scheduler.config.ts' })

    expectTypeOf(runtime.entry).toEqualTypeOf<string | URL>()
    expect(runtime.entry).toBe('./scheduler.config.ts')
  })
})

function createClientConfig() {
  return (() => ({})) as JobsClient
}
