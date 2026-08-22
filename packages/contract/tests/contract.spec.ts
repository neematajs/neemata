import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { TRouterContract } from '../src/index.ts'
import type {
  TAnyProcedureContract,
  TProcedureContract,
} from '../src/schemas/procedure.ts'
import type { TStreamContract } from '../src/schemas/stream.ts'
import type { SubscriptionEventMessage } from '../src/schemas/subscription.ts'
import { c, IsRouterContract, RouterContract } from '../src/index.ts'
import { EventContract, IsEventContract } from '../src/schemas/event.ts'
import {
  IsProcedureContract,
  ProcedureContract,
} from '../src/schemas/procedure.ts'
import { IsStreamContract, StreamContract } from '../src/schemas/stream.ts'
import {
  IsSubscriptionContract,
  SubscriptionContract,
} from '../src/schemas/subscription.ts'

describe('Exports', () => {
  it('Contract should be defined', () => {
    expect(c).toBeDefined()
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
      const event = c.event({ payload: t.string() })

      expectTypeOf(event.payload).toEqualTypeOf<t.StringType>()
    })
  })
})

describe('Contract — Subscription', { sequential: true }, () => {
  describe('Runtime', () => {
    it('should create a Subscription contract', () => {
      const testEvent = c.event({ payload: t.any() })

      const subscription = c.subscription({
        namespace: 'testSubscription',
        params: t.object({ id: t.string() }),
        key: (params) => params.id,
        events: { testEvent },
      })

      expect(subscription).toBeDefined()
      expect(subscription).toHaveProperty('type', 'neemata:subscription')
      expect(subscription).toHaveProperty('namespace', 'testSubscription')
      expect(subscription).toHaveProperty('events')
      expect(subscription.events.testEvent).toHaveProperty(
        'type',
        'neemata:event',
      )
      expect(subscription.events.testEvent).toHaveProperty('event', 'testEvent')
      expect(subscription.events.testEvent).toHaveProperty(
        'subscription',
        subscription,
      )
      expect(subscription.key({ id: 'one' })).toBe('one')
      expect(IsSubscriptionContract(subscription)).toBe(true)
      expect(IsEventContract(subscription.events.testEvent)).toBe(true)
    })
  })

  describe('Typings', () => {
    it('should correctly resolve Subscription contract types', () => {
      const subscription1 = c.subscription({
        namespace: 'testSubscription',
        params: t.object({ id: t.string() }),
        key: (params) => params.id,
        events: {
          event1: c.event({ payload: t.string() }),
          event2: c.event({
            payload: t.object({ id: t.number(), value: t.string() }),
          }),
        },
      })

      expectTypeOf(subscription1.params).toEqualTypeOf<
        t.ObjectType<{ id: t.StringType }>
      >()
      expectTypeOf(subscription1.namespace).toEqualTypeOf<'testSubscription'>()
      expectTypeOf(subscription1.key).toEqualTypeOf<
        (params: { id: string }) => string
      >()
      expectTypeOf(subscription1.events.event1.event).toEqualTypeOf<'event1'>()
      expectTypeOf(
        subscription1.events.event1.payload,
      ).toEqualTypeOf<t.StringType>()
      expectTypeOf(subscription1.events.event1.subscription).toEqualTypeOf<
        typeof subscription1
      >()
      expectTypeOf(subscription1.events.event2.event).toEqualTypeOf<'event2'>()
      expectTypeOf(subscription1.events.event2.subscription).toEqualTypeOf<
        typeof subscription1
      >()
      expectTypeOf<
        SubscriptionEventMessage<typeof subscription1.events.event1>
      >().toEqualTypeOf<{ event: 'event1'; payload: string }>()
      const message: SubscriptionEventMessage<
        typeof subscription1.events.event1
      > = { event: 'event1', payload: 'test' }
      expect(message.payload).toBe('test')
    })
  })
})

describe('Contract — Procedure', { sequential: true }, () => {
  describe('Runtime', () => {
    it('should create a Procedure contract', () => {
      const inputType = t.any()
      const outputType = t.any()
      const unnamedProcedure = c.procedure({
        input: inputType,
        output: outputType,
      })

      expect(unnamedProcedure).toBeDefined()
      expect(unnamedProcedure).toHaveProperty('name', undefined)
      expect(unnamedProcedure).toHaveProperty('type', 'neemata:procedure')
      expect(unnamedProcedure).toHaveProperty('input', inputType)
      expect(unnamedProcedure).toHaveProperty('output', outputType)
      expect(IsProcedureContract(unnamedProcedure)).toBe(true)
      expect(IsStreamContract(unnamedProcedure)).toBe(false)

      const namedProcedure = c.procedure({
        name: 'testProcedure',
        input: inputType,
        output: outputType,
      })

      expect(namedProcedure).toBeDefined()
      expect(namedProcedure).toHaveProperty('name', 'testProcedure')
      expect(namedProcedure).toHaveProperty('type', 'neemata:procedure')
      expect(namedProcedure).toHaveProperty('input', inputType)
      expect(namedProcedure).toHaveProperty('output', outputType)
      expect(IsProcedureContract(namedProcedure)).toBe(true)
      expect(IsStreamContract(namedProcedure)).toBe(false)
    })

    it('should create a Stream contract', () => {
      const inputType = t.any()
      const outputType = t.any()
      const streamContract = c.stream({
        name: 'testStream',
        input: inputType,
        output: outputType,
      })

      expect(streamContract).toBeDefined()
      expect(streamContract).toHaveProperty('name', 'testStream')
      expect(streamContract).toHaveProperty('type', 'neemata:stream')
      expect(streamContract).toHaveProperty('input', inputType)
      expect(streamContract).toHaveProperty('output', outputType)
      expect(IsStreamContract(streamContract)).toBe(true)
      expect(IsProcedureContract(streamContract)).toBe(false)
      expect(c).toHaveProperty('stream', StreamContract)

      // a stream contract must never be assignable where a procedure
      // contract is required — the kind split is a type-level boundary
      expectTypeOf(streamContract).not.toExtend<TAnyProcedureContract>()
    })
  })

  describe('Typings', () => {
    it('should correctly resolve Procedure contract types', () => {
      const simpleProcedure = c.procedure({
        input: t.string(),
        output: t.string(),
      })

      const namedProcedure = c.procedure({ name: 'testProcedure' })

      const streamContract = c.stream({
        input: t.object({ name: t.string(), age: t.number() }),
        output: t.object({ greeting: t.string() }),
      })

      expectTypeOf(simpleProcedure.name).toEqualTypeOf<undefined>()
      expectTypeOf(simpleProcedure.input).toEqualTypeOf<t.StringType>()
      expectTypeOf(simpleProcedure.output).toEqualTypeOf<t.StringType>()
      expectTypeOf(simpleProcedure.type).toEqualTypeOf<'neemata:procedure'>()

      expectTypeOf(streamContract.name).toEqualTypeOf<undefined>()
      expectTypeOf(streamContract.input).toEqualTypeOf<
        t.ObjectType<{ name: t.StringType; age: t.NumberType }>
      >()
      expectTypeOf(streamContract.output).toEqualTypeOf<
        t.ObjectType<{ greeting: t.StringType }>
      >()
      expectTypeOf(streamContract.type).toEqualTypeOf<'neemata:stream'>()

      expectTypeOf(namedProcedure.name).toEqualTypeOf<'testProcedure'>()
      expectTypeOf(namedProcedure.input).toEqualTypeOf<t.NeverType>()
      expectTypeOf(namedProcedure.output).toEqualTypeOf<t.NeverType>()
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
          inlineStream: c.stream({
            input: t.any(),
            output: t.any(),
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
      expect(IsStreamContract(router.routes.inlineStream)).toBe(true)
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
          inlineStream: c.stream({
            input: t.any(),
            output: t.string(),
          }),
          nested: nestedRouter,
        },
      })

      expectTypeOf(routerContract.name).toEqualTypeOf<undefined>()
      expectTypeOf(routerContract.routes.simpleProcedure).toEqualTypeOf<
        TProcedureContract<t.StringType, t.StringType, 'simpleProcedure'>
      >()
      expectTypeOf(routerContract.routes.inlineProcedure).toEqualTypeOf<
        TProcedureContract<t.AnyType, t.AnyType, 'inlineProcedure'>
      >()

      expectTypeOf(routerContract.routes.inlineStream).toEqualTypeOf<
        TStreamContract<t.AnyType, t.StringType, 'inlineStream'>
      >()

      expectTypeOf(routerContract.routes.nested).toEqualTypeOf<
        TRouterContract<
          {
            readonly nestedProcedure: TProcedureContract<
              t.AnyType,
              t.AnyType,
              'nested/nestedProcedure'
            >
          },
          'nested'
        >
      >()
    })
  })
})

describe('Contract — Router', { sequential: true }, () => {
  describe('Runtime', () => {
    it('should create a Router contract', () => {
      const inputType = t.any()
      const outputType = t.any()
      const router = c.router({
        routes: {
          testProcedure: c.procedure({ input: inputType, output: outputType }),
        },
        name: 'root',
      })

      expect(router).toBeDefined()
      expect(router).toHaveProperty('type', 'neemata:router')
      expect(router).toHaveProperty('name', 'root')
      expect(router).toHaveProperty('routes')
      expect(IsRouterContract(router)).toBe(true)
    })
  })

  describe('Typings', () => {
    it('should correctly resolve a router contract types', () => {
      const router = c.router({
        routes: {
          testProcedure: c.procedure({ input: t.string(), output: t.string() }),
        },
        name: 'root',
      })

      expectTypeOf(router.name).toEqualTypeOf<'root'>()
      expectTypeOf(router.routes.testProcedure).toEqualTypeOf<
        TProcedureContract<t.StringType, t.StringType, 'root/testProcedure'>
      >()
    })
  })
})
