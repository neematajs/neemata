import { createEventConsumer, EventStreamContract } from '@nmtjs/eventing'
import {
  defineEventingPlanner,
  defineEventingRuntime,
} from '@nmtjs/eventing/neem'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

describe('@nmtjs/eventing Neem runtime helpers', () => {
  it('declares an eventing runtime with caller-owned worker entry and no host', () => {
    const runtime = defineEventingRuntime({
      name: 'events',
      planner: './events.planner.ts',
      worker: './events.worker.ts',
    })

    expect(runtime).toMatchObject({
      name: 'events',
      planner: './events.planner.ts',
      worker: { entry: './events.worker.ts' },
    })
    expect(runtime.host).toBeUndefined()
  })

  it('spreads consumers across requested worker threads by index', async () => {
    const event = EventStreamContract({
      name: 'user.created',
      topic: 'users',
      key: t.string(),
      payload: t.object({ id: t.string() }),
    })
    const consumers = [0, 1, 2].map((index) =>
      createEventConsumer(event, {
        groupId: 'events',
        consumerId: `consumer-${index}`,
        async handle() {},
      }),
    )
    const planner = defineEventingPlanner(() => ({
      adapter: () => {
        throw new Error('planner must not open eventing adapter')
      },
      consumers: () => consumers,
      threads: 2,
    }))

    const plan = await planner()

    expect(plan.workers).toEqual([
      { consumerIndexes: [0, 2] },
      { consumerIndexes: [1] },
    ])
    expect(plan.options).toBeUndefined()
  })
})
