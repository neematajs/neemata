import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { TRouterContract } from '../src/index.ts'
import type { TEventContract } from '../src/schemas/event.ts'
import type { TProcedureContract } from '../src/schemas/procedure.ts'
import { c, IsRouterContract, RouterContract } from '../src/index.ts'
import { APIContract, IsAPIContract } from '../src/schemas/api.ts'
import { EventContract, IsEventContract } from '../src/schemas/event.ts'
import {
  IsProcedureContract,
  IsStreamProcedureContract,
  ProcedureContract,
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

  it('should export Router contract', () => {
    expect(c).toHaveProperty('router', RouterContract)
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
      const event = c.event({ payload: eventType })

      expect(event).toBeDefined()
      expect(event).toHaveProperty('type', 'neemata:event')
      expect(event).toHaveProperty('payload', eventType)
    })
  })

  describe('Typings', () => {
    it('should correctly resolve Event contract types', () => {
      const unnamedEvent = c.event({ payload: t.string() })

      expectTypeOf(unnamedEvent.name).toEqualTypeOf<undefined>()
      expectTypeOf(unnamedEvent.payload).toEqualTypeOf<t.StringType>()

      const namedEvent = c.event({
        name: 'testEvent',
        payload: t.object({ id: t.number(), value: t.string() }),
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
      const testEvent = c.event({ payload: t.any() })

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
      expect(subscription.events.testEvent).toHaveProperty(
        'name',
        'testSubscription/testEvent',
      )
      expect(IsSubscriptionContract(subscription)).toBe(true)
      expect(IsEventContract(subscription.events.testEvent)).toBe(true)
    })

    it('should create a Subscription contract with options', () => {
      const testEvent = c.event({ payload: t.any() })

      const subscription = c.subscription.withOptions<{ test: string }>()({
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
      expect(subscription.events.testEvent).toHaveProperty(
        'name',
        'testSubscription/testEvent',
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
          event1: c.event({ payload: t.string() }),
          event2: c.event({
            payload: t.object({ id: t.number(), value: t.string() }),
          }),
        },
      })

      expectTypeOf(subscription1.options).toEqualTypeOf<null>()
      expectTypeOf(subscription1.name).toEqualTypeOf<'testSubscription'>()
      expectTypeOf(subscription1.events.event1).toEqualTypeOf<
        TEventContract<t.StringType, 'testSubscription/event1', null>
      >()
      expectTypeOf(subscription1.events.event2).toEqualTypeOf<
        TEventContract<
          t.ObjectType<{ id: t.NumberType; value: t.StringType }>,
          'testSubscription/event2',
          null
        >
      >()
    })

    it('should correctly resolve Subscription contract types with options', () => {
      const subscription2 = c.subscription.withOptions<{ test: string }>()({
        name: 'testSubscription',
        events: { event1: c.event({ payload: t.string() }) },
      })

      expectTypeOf(subscription2.options).toEqualTypeOf<{ test: string }>()
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

      const namedProcedure = c.procedure({ name: 'testProcedure' })

      const streamProcedure = c.procedure({
        input: t.object({ name: t.string(), age: t.number() }),
        output: t.object({ greeting: t.string() }),
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

describe('Contract — Router', { sequential: true }, () => {
  describe('Runtime', () => {
    it('should create a Router contract', () => {
      const inputType = t.any()
      const outputType = t.any()
      const eventType = t.any()

      const event = c.event({ payload: eventType })

      const procedure = c.procedure({ input: inputType, output: outputType })

      const nestedRouter = c.router({
        routes: {
          nestedProcedure: c.procedure({ input: t.any(), output: t.any() }),
        },
        events: { nestedEvent: c.event({ payload: t.any() }) },
        name: 'nested',
      })

      const router = c.router({
        routes: {
          variableProcedure: procedure,
          inlineProcedure: c.procedure({ input: t.any(), output: t.any() }),
          inlineProcedureWithStream: c.procedure({
            input: t.any(),
            output: t.any(),
            stream: t.any(),
          }),
          nested: nestedRouter,
        },
        events: {
          variableEvent: event,
          inlineEvent: c.event({ payload: t.any() }),
        },
      })

      expect(router).toBeDefined()
      expect(router).toHaveProperty('name', undefined)
      expect(router).toHaveProperty('type', 'neemata:router')
      expect(router).toHaveProperty('routes')

      expect(IsRouterContract(router)).toBe(true)

      expect(IsProcedureContract(router.routes.inlineProcedure)).toBe(true)
      expect(IsProcedureContract(router.routes.inlineProcedureWithStream)).toBe(
        true,
      )
      expect(IsProcedureContract(router.routes.variableProcedure)).toBe(true)
      expect(IsRouterContract(router.routes.nested)).toBe(true)
    })
  })

  describe('Typings', () => {
    it('should correctly resolve Router contract types', () => {
      const simpleProcedure = c.procedure({
        input: t.string(),
        output: t.string(),
      })
      const testEvent = c.event({ payload: t.object({ message: t.string() }) })

      const nestedRouter = c.router({
        routes: {
          nestedProcedure: c.procedure({ input: t.any(), output: t.any() }),
        },
        events: { nestedEvent: c.event({ payload: t.any() }) },
      })

      const routerContract = c.router({
        routes: {
          simpleProcedure,
          inlineProcedure: c.procedure({ input: t.any(), output: t.any() }),
          inlineProcedureWithStream: c.procedure({
            input: t.any(),
            output: t.any(),
            stream: t.string(),
          }),
          nested: nestedRouter,
        },
        events: {
          testEvent: testEvent,
          inlineEvent: c.event({ payload: t.object({ data: t.string() }) }),
        },
      })

      expectTypeOf(routerContract.name).toEqualTypeOf<undefined>()
      expectTypeOf(routerContract.routes.simpleProcedure).toEqualTypeOf<
        TProcedureContract<
          t.StringType,
          t.StringType,
          undefined,
          'simpleProcedure'
        >
      >()
      expectTypeOf(routerContract.routes.inlineProcedure).toEqualTypeOf<
        TProcedureContract<t.AnyType, t.AnyType, undefined, 'inlineProcedure'>
      >()

      expectTypeOf(
        routerContract.routes.inlineProcedureWithStream,
      ).toEqualTypeOf<
        TProcedureContract<
          t.AnyType,
          t.AnyType,
          t.StringType,
          'inlineProcedureWithStream'
        >
      >()

      expectTypeOf(routerContract.routes.nested).toEqualTypeOf<
        TRouterContract<
          {
            readonly nestedProcedure: TProcedureContract<
              t.AnyType,
              t.AnyType,
              undefined,
              'nested/nestedProcedure'
            >
          },
          'nested'
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

      const api = c.api({
        router: c.router({
          routes: {
            testProcedure: c.procedure({
              input: inputType,
              output: outputType,
            }),
          },

          name: 'root',
        }),
      })

      expect(api).toBeDefined()
      expect(api).toHaveProperty('type', 'neemata:api')
      expect(api).toHaveProperty('router')
      expect(IsAPIContract(api)).toBe(true)
    })
  })

  describe('Typings', () => {
    it('should correctly resolve API contract types', () => {
      const api = c.api({
        router: c.router({
          routes: {
            testProcedure: c.procedure({
              input: t.string(),
              output: t.string(),
            }),
          },
          name: 'test',
        }),
      })

      expect(api).toHaveProperty('router')
      expect(api.router).toHaveProperty('routes')
      expect(api.router.routes.testProcedure).toBeDefined()
      expect(api.router.routes.testProcedure.name).toBe('test/testProcedure')
      expectTypeOf(api.router.name).toEqualTypeOf<'test'>()
      expectTypeOf(api.router).toEqualTypeOf<
        TRouterContract<
          {
            readonly testProcedure: TProcedureContract<
              t.StringType,
              t.StringType,
              undefined,
              'test/testProcedure'
            >
          },
          'test'
        >
      >()
    })
  })
})
