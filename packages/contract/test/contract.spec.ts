import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'
import { c, NamespaceContract } from '../src/index.ts'
import { APIContract } from '../src/schemas/api.ts'
import { EventContract } from '../src/schemas/event.ts'
import { ProcedureContract } from '../src/schemas/procedure.ts'
import {
  IsSubscriptionContract,
  SubscriptionContract,
} from '../src/schemas/subscription.ts'

describe('Exports', () => {
  it('Contract should be defined', () => {
    expect(c).toBeDefined()
  })

  it('should export API contract', () => {
    expect(c).toHaveProperty('api', APIContract)
  })

  it('should export Namespace contract', () => {
    expect(c).toHaveProperty('namespace', NamespaceContract)
  })

  it('should export Procedure contract', () => {
    expect(c).toHaveProperty('procedure', ProcedureContract)
  })

  it('should export Subscription contract', () => {
    expect(c).toHaveProperty('subscription', SubscriptionContract)
  })

  it('should export Event contract', () => {
    expect(c).toHaveProperty('event', EventContract)
  })
})

describe('Contracts', { sequential: true }, () => {
  const inputType = t.any()
  const outputType = t.any()
  const eventType = t.any()

  const api = c.api({
    namespaces: {
      testNamespace: c.namespace({
        procedures: {
          testProcedure: c.procedure({
            input: inputType,
            output: outputType,
          }),
        },
        events: {
          testNamespaceEvent: c.event({
            payload: eventType,
          }),
        },
      }),
    },
  })

  it('should create an API contract', () => {
    expect(api).toBeDefined()
    expect(api).toHaveProperty('type', 'neemata:api')
    expect(api).toHaveProperty('namespaces')
  })

  it('should create a Namespace contract', () => {
    expect(api.namespaces.testNamespace).toBeDefined()
    expect(api.namespaces.testNamespace).toHaveProperty(
      'type',
      'neemata:namespace',
    )
    expect(api.namespaces.testNamespace).toHaveProperty('name', 'testNamespace')
    expect(api.namespaces.testNamespace).toHaveProperty('procedures')
    expect(api.namespaces.testNamespace).toHaveProperty('subscriptions')
    expect(api.namespaces.testNamespace).toHaveProperty('events')
  })

  it('should create a Procedure contract', () => {
    expect(api.namespaces.testNamespace.procedures.testProcedure).toBeDefined()
    expect(
      api.namespaces.testNamespace.procedures.testProcedure,
    ).toHaveProperty('type', 'neemata:procedure')
    expect(
      api.namespaces.testNamespace.procedures.testProcedure,
    ).toHaveProperty('input', inputType)
    expect(
      api.namespaces.testNamespace.procedures.testProcedure,
    ).toHaveProperty('output', outputType)
    expect(
      api.namespaces.testNamespace.procedures.testProcedure,
    ).toHaveProperty('stream', expect.any(t.NeverType))
    expect(
      api.namespaces.testNamespace.procedures.testProcedure,
    ).toHaveProperty('name', 'testProcedure')
    expect(
      api.namespaces.testNamespace.procedures.testProcedure,
    ).toHaveProperty('namespace', 'testNamespace')
  })

  it('should create a Namespace Event contract', () => {
    expect(api.namespaces.testNamespace.events.testNamespaceEvent).toBeDefined()
    expect(
      api.namespaces.testNamespace.events.testNamespaceEvent,
    ).toHaveProperty('type', 'neemata:event')
    expect(
      api.namespaces.testNamespace.events.testNamespaceEvent,
    ).toHaveProperty('payload', eventType)
    expect(
      api.namespaces.testNamespace.events.testNamespaceEvent,
    ).toHaveProperty('name', 'testNamespaceEvent')
    expect(
      api.namespaces.testNamespace.events.testNamespaceEvent,
    ).toHaveProperty('namespace', 'testNamespace')
  })

  it('should create a Subscription contract', () => {
    const testEvent = c.event({
      payload: eventType,
    })

    const subscription = c
      .subscription({
        name: 'testSubscription',
        events: {
          testEvent,
        },
      })
      .$withOptions<{ maxConnections: number }>()

    expect(subscription).toBeDefined()
    expect(subscription).toHaveProperty('type', 'neemata:subscription')
    expect(subscription).toHaveProperty('name', 'testSubscription')
    expect(subscription).toHaveProperty('events')
    expect(subscription.events.testEvent).toHaveProperty(
      'type',
      'neemata:event',
    )
    expect(subscription.events.testEvent).toHaveProperty('name', 'testEvent')
    expect(subscription.events.testEvent).toHaveProperty(
      'subscription',
      'testSubscription',
    )
    expect(IsSubscriptionContract(subscription)).toBe(true)
  })
})
