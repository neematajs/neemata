import type { Logger } from '@nmtjs/core'
import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { CoreInjectables, createValueInjectable } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { implementSubscription } from '../src/index.ts'

describe('subscription consumer implementation helper', () => {
  const contract = SubscriptionContract({
    namespace: 'echo',
    params: t.object({ id: t.string() }),
    key: ({ id }) => id,
    events: {
      requested: EventContract({ payload: t.object({ id: t.string() }) }),
      completed: EventContract({ payload: t.object({ ok: t.boolean() }) }),
    },
  })

  it('builds a subscription consumer from callable event builders', () => {
    const events = implementSubscription(contract)
    const prefix = createValueInjectable('echo')
    const consumer = events(
      {
        requested: events.requested({
          dependencies: { prefix, logger: CoreInjectables.logger },
          handler: ({ prefix, logger }, event) => {
            expectTypeOf(prefix).toEqualTypeOf<string>()
            expectTypeOf(logger).toEqualTypeOf<Logger>()
            expectTypeOf(event.event).toEqualTypeOf<'requested'>()
            expectTypeOf(event.payload.id).toEqualTypeOf<string>()
            return Promise.resolve()
          },
        }),
      },
      { groupId: 'echo-service', from: 'earliest' },
    )

    expect(consumer.subscription).toBe(contract)
    expect(consumer.groupId).toBe('echo-service')
    expect(consumer.from).toBe('earliest')
    expect(consumer.handlers.requested?.event).toBe(contract.events.requested)
    expect(consumer.handlers.completed).toBeUndefined()
  })

  it('rejects unknown handlers and supports prototype event names', () => {
    const prototypeContract = SubscriptionContract({
      namespace: 'prototype',
      events: {
        call: EventContract({ payload: t.string() }),
        toString: EventContract({ payload: t.string() }),
        prototype: EventContract({ payload: t.string() }),
      },
    })
    const events = implementSubscription(prototypeContract)

    const consumer = events(
      {
        call: events.call(async () => {}),
        toString: events.toString(async () => {}),
        prototype: events.prototype(async () => {}),
      },
      { groupId: 'prototype-service' },
    )

    expect(consumer.handlers.call?.event).toBe(prototypeContract.events.call)
    expect(consumer.handlers.toString?.event).toBe(
      prototypeContract.events.toString,
    )
    expect(consumer.handlers.prototype?.event).toBe(
      prototypeContract.events.prototype,
    )
    expect(() =>
      events({ missing: events.call(async () => {}) } as any, {
        groupId: 'prototype-service',
      }),
    ).toThrow('Unknown subscription event handler [missing]')
  })
})
