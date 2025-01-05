import { describe, expect, it } from 'vitest'

import test from 'node:test'
import { t } from '@nmtjs/type'
import { builtin } from '../lib/common.ts'
import { kProcedure, kProcedureSubscription } from '../lib/constants.ts'
import { createValueInjectable } from '../lib/container.ts'
import {
  createContractProcedure,
  createProcedure,
  createProcedureMetadataKey,
  getProcedureMetadata,
} from '../lib/procedure.ts'
import {
  $createSubscription,
  createContractSubscription,
} from '../lib/subscription-procedure.ts'
import { SubscriptionResponse } from '../lib/subscription.ts'
import { noop } from '../lib/utils/functions.ts'
import { TestServiceContract } from './_utils.ts'

describe('Subsctiption procedure', () => {
  const procedureContract = TestServiceContract.procedures.testSubscription

  it('should create a procedure', () => {
    const handler = () => {}
    const procedure = createContractSubscription(
      procedureContract,
      handler as any,
    )

    expect(kProcedureSubscription in procedure).toBe(true)
    expect(procedure).toHaveProperty('contract', procedureContract)
    expect(procedure).toHaveProperty('handler', handler)
    expect(procedure).toHaveProperty('dependencies', {})
    expect(procedure).toHaveProperty('guards', expect.any(Set))
    expect(procedure).toHaveProperty('middlewares', expect.any(Set))
    expect(procedure).toHaveProperty('metadata', expect.any(Map))
  })

  it('should create a procedure with dependencies', () => {
    const dep1 = createValueInjectable('dep1')
    const dep2 = createValueInjectable('dep2')

    const procedure = createContractProcedure(procedureContract, {
      handler: noop,
      dependencies: { dep1, dep2 },
    })

    expect(procedure.dependencies).toHaveProperty('dep1', dep1)
    expect(procedure.dependencies).toHaveProperty('dep2', dep2)
  })

  it('should create a procedure with guards', () => {
    const guard1 = createValueInjectable({ can: () => false })
    const guard2 = createValueInjectable({ can: () => true })

    const procedure = createContractProcedure(procedureContract, {
      handler: noop,
      guards: [guard1, guard2],
    })

    expect([...procedure.guards]).toStrictEqual([guard1, guard2])
  })

  it('should create a procedure with middlewares', () => {
    const middleware1 = createValueInjectable({
      handle: () => void 0,
    })
    const middleware2 = createValueInjectable({
      handle: () => void 0,
    })

    const procedure = createContractProcedure(procedureContract, {
      handler: noop,
      middlewares: [middleware1, middleware2],
    })

    expect([...procedure.middlewares]).toStrictEqual([middleware1, middleware2])
  })

  it('should create a procedure with metadata', () => {
    const metadataKey = createProcedureMetadataKey<string>('test')
    const procedure = createContractProcedure(procedureContract, {
      handler: noop,
      metadata: [metadataKey.as('some')],
    })

    expect(getProcedureMetadata(procedure, metadataKey)).toBe('some')
  })

  it('should create a procedure with handler', () => {
    const handler = () => 'result'
    const procedure = createContractProcedure(procedureContract, handler)

    expect(procedure.handler).toBe(handler)
  })
})

describe('Procedure static', () => {
  it('should create a procedure', () => {
    const input = t.string()
    const output = t.object({ a: t.literal('dep1') })
    const dep1 = createValueInjectable('dep1' as const)
    const dep2 = createValueInjectable('dep2')

    const procedure = $createSubscription<{}>()({
      input,
      output,
      events: {
        testEvent: t.string(),
      },
      dependencies: {
        eventManager: builtin.eventManager,
        connection: builtin.connection,
        dep1,
        dep2,
      },
      async handler(ctx, data, contract) {
        const { subscription } = await ctx.eventManager.subscribe(
          contract,
          {},
          ctx.connection,
        )
        return new SubscriptionResponse(subscription as any)
      },
    })

    expect(kProcedureSubscription in procedure).toBe(true)
    expect(procedure).toHaveProperty('contract', {
      type: 'neemata:subscription',
      events: {
        testEvent: expect.anything(),
      },
      input,
      output,
      options: undefined,
      name: undefined,
      serviceName: undefined,
      transports: undefined,
      timeout: undefined,
    })
  })
})
