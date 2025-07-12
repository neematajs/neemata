import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { c, IsNamespaceContract, NamespaceContract } from '../src/index.ts'
import { APIContract, IsAPIContract } from '../src/schemas/api.ts'
import {
  EventContract,
  IsEventContract,
  type TEventContract,
} from '../src/schemas/event.ts'
import {
  IsProcedureContract,
  IsStreamProcedureContract,
  ProcedureContract,
  type TProcedureContract,
} from '../src/schemas/procedure.ts'
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

describe('Contract — Event', { sequential: true }, () => {
  describe('Runtime', () => {
    it('should create an Event contract', () => {
      const eventType = t.any()
      const event = c.event({
        payload: eventType,
      })

      expect(event).toBeDefined()
      expect(event).toHaveProperty('type', 'neemata:event')
      expect(event).toHaveProperty('payload', eventType)
    })
  })

  describe('Typings', () => {
    it('should correctly resolve Event contract types', () => {
      const unnamedEvent = c.event({
        payload: t.string(),
      })

      expectTypeOf(unnamedEvent.name).toEqualTypeOf<undefined>()
      expectTypeOf(unnamedEvent.payload).toEqualTypeOf<t.StringType>()

      const namedEvent = c.event({
        name: 'testEvent',
        payload: t.object({
          id: t.number(),
          value: t.string(),
        }),
      })
      expectTypeOf(namedEvent.name).toEqualTypeOf<'testEvent'>()
      expectTypeOf(namedEvent.payload).toEqualTypeOf<
        t.ObjectType<{ id: t.NumberType; value: t.StringType }>
      >()
    })
  })
})

describe('Contract — Subscription', { sequential: true }, () => {
  describe('Runtime', () => {
    it('should create a Subscription contract', () => {
      const testEvent = c.event({
        payload: t.any(),
      })

      const subscription = c.subscription({
        name: 'testSubscription',
        events: { testEvent },
      })

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
      expect(IsEventContract(subscription.events.testEvent)).toBe(true)
    })

    it('should create a Subscription contract with options', () => {
      const testEvent = c.event({
        payload: t.any(),
      })

      const subscription = c.subscription.withOptions<{
        test: string
      }>()({
        name: 'testSubscription',
        events: { testEvent },
      })

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
      expect(IsEventContract(subscription.events.testEvent)).toBe(true)
    })
  })

  describe('Typings', () => {
    it('should correctly resolve Subscription contract types', () => {
      const subscription1 = c.subscription({
        name: 'testSubscription',
        events: {
          event1: c.event({
            payload: t.string(),
          }),
          event2: c.event({
            payload: t.object({
              id: t.number(),
              value: t.string(),
            }),
          }),
        },
      })

      expectTypeOf(subscription1.options).toEqualTypeOf<null>()
      expectTypeOf(subscription1.name).toEqualTypeOf<'testSubscription'>()
      expectTypeOf(subscription1.events.event1).toEqualTypeOf<
        TEventContract<t.StringType, 'event1', 'testSubscription', undefined>
      >()
      expectTypeOf(subscription1.events.event2).toEqualTypeOf<
        TEventContract<
          t.ObjectType<{ id: t.NumberType; value: t.StringType }>,
          'event2',
          'testSubscription',
          undefined
        >
      >()
    })

    it('should correctly resolve Subscription contract types with options', () => {
      const subscription2 = c.subscription.withOptions<{
        test: string
      }>()({
        name: 'testSubscription',
        events: {
          event1: c.event({
            payload: t.string(),
          }),
        },
      })

      expectTypeOf(subscription2.options).toEqualTypeOf<{
        test: string
      }>()
    })
  })
})

describe('Contract — Procedure', { sequential: true }, () => {
  describe('Runtime', () => {
    it('should create a Procedure contract', () => {
      const inputType = t.any()
      const outputType = t.any()
      const streamType = t.any()
      const unnamedProcedure = c.procedure({
        input: inputType,
        output: outputType,
      })

      expect(unnamedProcedure).toBeDefined()
      expect(unnamedProcedure).toHaveProperty('name', undefined)
      expect(unnamedProcedure).toHaveProperty('type', 'neemata:procedure')
      expect(unnamedProcedure).toHaveProperty('input', inputType)
      expect(unnamedProcedure).toHaveProperty('output', outputType)
      expect(unnamedProcedure).toHaveProperty('stream', undefined)
      expect(IsProcedureContract(unnamedProcedure)).toBe(true)
      expect(IsStreamProcedureContract(unnamedProcedure)).toBe(false)

      const namedProcedure = c.procedure({
        name: 'testProcedure',
        input: inputType,
        output: outputType,
        stream: streamType,
      })
      expect(namedProcedure).toBeDefined()
      expect(namedProcedure).toHaveProperty('name', 'testProcedure')
      expect(namedProcedure).toHaveProperty('type', 'neemata:procedure')
      expect(namedProcedure).toHaveProperty('input', inputType)
      expect(namedProcedure).toHaveProperty('output', outputType)
      expect(namedProcedure).toHaveProperty('stream', streamType)
      expect(IsProcedureContract(namedProcedure)).toBe(true)
      expect(IsStreamProcedureContract(namedProcedure)).toBe(true)
    })
  })

  describe('Typings', () => {
    it('should correctly resolve Procedure contract types', () => {
      const simpleProcedure = c.procedure({
        input: t.string(),
        output: t.string(),
      })

      const namedProcedure = c.procedure({
        name: 'testProcedure',
      })

      const streamProcedure = c.procedure({
        input: t.object({
          name: t.string(),
          age: t.number(),
        }),
        output: t.object({
          greeting: t.string(),
        }),
        stream: t.string(),
      })

      expectTypeOf(simpleProcedure.name).toEqualTypeOf<undefined>()
      expectTypeOf(simpleProcedure.input).toEqualTypeOf<t.StringType>()
      expectTypeOf(simpleProcedure.output).toEqualTypeOf<t.StringType>()
      expectTypeOf(simpleProcedure.stream).toEqualTypeOf<undefined>()

      expectTypeOf(streamProcedure.name).toEqualTypeOf<undefined>()
      expectTypeOf(streamProcedure.input).toEqualTypeOf<
        t.ObjectType<{ name: t.StringType; age: t.NumberType }>
      >()
      expectTypeOf(streamProcedure.output).toEqualTypeOf<
        t.ObjectType<{ greeting: t.StringType }>
      >()
      expectTypeOf(streamProcedure.stream).toEqualTypeOf<t.StringType>()

      expectTypeOf(namedProcedure.name).toEqualTypeOf<'testProcedure'>()
      expectTypeOf(namedProcedure.input).toEqualTypeOf<t.NeverType>()
      expectTypeOf(namedProcedure.output).toEqualTypeOf<t.NeverType>()
      expectTypeOf(namedProcedure.stream).toEqualTypeOf<undefined>()
    })
  })
})

describe('Contract — Namespace', { sequential: true }, () => {
  describe('Runtime', () => {
    it('should create a Namespace contract', () => {
      const inputType = t.any()
      const outputType = t.any()
      const eventType = t.any()

      const event = c.event({
        payload: eventType,
      })

      const procedure = c.procedure({
        input: inputType,
        output: outputType,
      })

      const namespace = c.namespace({
        procedures: {
          variableProcedure: procedure,
          inlineProcedure: c.procedure({
            input: t.any(),
            output: t.any(),
          }),
          inlineProcedureWithStream: c.procedure({
            input: t.any(),
            output: t.any(),
            stream: t.any(),
          }),
        },
        events: {
          variableEvent: event,
          inlineEvent: c.event({
            payload: t.any(),
          }),
        },
      })

      expect(namespace).toBeDefined()
      expect(namespace).toHaveProperty('name', undefined)
      expect(namespace).toHaveProperty('type', 'neemata:namespace')
      expect(namespace).toHaveProperty('procedures')
      expect(namespace).toHaveProperty('events')

      expect(IsNamespaceContract(namespace)).toBe(true)
      expect(IsEventContract(namespace.events.inlineEvent)).toBe(true)
      expect(IsEventContract(namespace.events.variableEvent)).toBe(true)

      expect(IsProcedureContract(namespace.procedures.inlineProcedure)).toBe(
        true,
      )
      expect(
        IsProcedureContract(namespace.procedures.inlineProcedureWithStream),
      ).toBe(true)
      expect(IsProcedureContract(namespace.procedures.variableProcedure)).toBe(
        true,
      )
    })
  })

  describe('Typings', () => {
    it('should correctly resolve Namespace contract types', () => {
      const simpleProcedure = c.procedure({
        input: t.string(),
        output: t.string(),
      })
      const testEvent = c.event({
        payload: t.object({
          message: t.string(),
        }),
      })
      const namespaceContract = c.namespace({
        name: 'testNamespace',
        procedures: {
          simpleProcedure,
          inlineProcedure: c.procedure({
            input: t.any(),
            output: t.any(),
          }),
          inlineProcedureWithStream: c.procedure({
            input: t.any(),
            output: t.any(),
            stream: t.string(),
          }),
        },
        events: {
          testEvent: testEvent,
          inlineEvent: c.event({
            payload: t.object({
              data: t.string(),
            }),
          }),
        },
      })

      expectTypeOf(namespaceContract.name).toEqualTypeOf<'testNamespace'>()
      expectTypeOf(namespaceContract.procedures.simpleProcedure).toEqualTypeOf<
        TProcedureContract<
          t.StringType,
          t.StringType,
          undefined,
          'simpleProcedure',
          'testNamespace'
        >
      >()
      expectTypeOf(namespaceContract.procedures.inlineProcedure).toEqualTypeOf<
        TProcedureContract<
          t.AnyType,
          t.AnyType,
          undefined,
          'inlineProcedure',
          'testNamespace'
        >
      >()

      expectTypeOf(
        namespaceContract.procedures.inlineProcedureWithStream,
      ).toEqualTypeOf<
        TProcedureContract<
          t.AnyType,
          t.AnyType,
          t.StringType,
          'inlineProcedureWithStream',
          'testNamespace'
        >
      >()

      expectTypeOf(namespaceContract.events.testEvent).toEqualTypeOf<
        TEventContract<
          t.ObjectType<{ message: t.StringType }>,
          'testEvent',
          undefined,
          'testNamespace'
        >
      >()

      expectTypeOf(namespaceContract.events.inlineEvent).toEqualTypeOf<
        TEventContract<
          t.ObjectType<{ data: t.StringType }>,
          'inlineEvent',
          undefined,
          'testNamespace'
        >
      >()
    })
  })
})

describe('Contract — API', { sequential: true }, () => {
  describe('Runtime', () => {
    it('should create an API contract', () => {
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

      expect(api).toBeDefined()
      expect(api).toHaveProperty('type', 'neemata:api')
      expect(api).toHaveProperty('namespaces')
      expect(IsAPIContract(api)).toBe(true)
    })
  })

  describe('Typings', () => {
    it('should correctly resolve API contract types', () => {
      const api = c.api({
        namespaces: {
          testNamespace: c.namespace({
            procedures: {
              testProcedure: c.procedure({
                input: t.string(),
                output: t.string(),
              }),
            },
            events: {
              testEvent: c.event({
                payload: t.object({
                  message: t.string(),
                }),
              }),
            },
          }),
        },
      })

      // These type checks verify the API contract structure
      expect(api).toHaveProperty('namespaces')
      expect(api.namespaces.testNamespace).toHaveProperty('procedures')
      expect(api.namespaces.testNamespace).toHaveProperty('events')
    })
  })
})
