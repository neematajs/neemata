import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { createEventConsumer, implementSubscription } from '@nmtjs/eventing'
import { defineEventingPlanner } from '@nmtjs/eventing/neem/planner'
import { defineRuntime } from '@nmtjs/neem'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

describe('@nmtjs/eventing Neem runtime helpers', () => {
  it('declares an eventing runtime with caller-owned worker entry and no host', () => {
    const runtime = defineRuntime({
      name: 'events',
      planner: './events.planner.ts',
      worker: { entry: './events.worker.ts' },
    })

    expect(runtime).toMatchObject({
      name: 'events',
      planner: './events.planner.ts',
      worker: { entry: './events.worker.ts' },
    })
    expect('host' in runtime).toBe(false)
  })

  it('spreads consumers across requested worker threads by index', async () => {
    const stream = SubscriptionContract({
      namespace: 'users',
      params: t.object({ id: t.string() }),
      key: ({ id }) => id,
      events: {
        userCreated: EventContract({ payload: t.object({ id: t.string() }) }),
      },
    })
    const event = stream.events.userCreated
    const consumers = [0, 1, 2].map((index) =>
      createEventConsumer(event, {
        groupId: 'events',
        consumerId: `consumer-${index}`,
        async handle() {},
      }),
    )
    expect(consumers[0]?.message).toBe(event)
    const planner = defineEventingPlanner(() => ({
      adapter: () => {
        throw new Error('planner must not open eventing adapter')
      },
      consumers,
      threads: 2,
    }))

    const plan = await planner()

    expect(plan.workers).toEqual([
      { consumerIndexes: [0, 2] },
      { consumerIndexes: [1] },
    ])
    expect(plan.options).toBeUndefined()
  })

  it('accepts subscription consumers in eventing runtime config', async () => {
    const stream = SubscriptionContract({
      namespace: 'users',
      events: {
        userCreated: EventContract({ payload: t.object({ id: t.string() }) }),
      },
    })
    const users = implementSubscription(stream)
    const consumers = [
      users(
        { userCreated: users.userCreated(async () => {}) },
        { groupId: 'events' },
      ),
    ]
    const planner = defineEventingPlanner(() => ({
      adapter: () => {
        throw new Error('planner must not open eventing adapter')
      },
      consumers,
      threads: 1,
    }))

    const plan = await planner()

    expect(plan.workers).toEqual([{ consumerIndexes: [0] }])
  })
})
