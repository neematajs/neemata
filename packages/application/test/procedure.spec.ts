import { noopFn } from '@nmtjs/common'
import { createMetadataKey, createValueInjectable } from '@nmtjs/core'
import { type } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'
import { kProcedure } from '../src/constants.ts'
import {
  createContractProcedure,
  createProcedure,
  createStreamResponse,
} from '../src/procedure.ts'
import { TestNamespaceContract } from './_utils.ts'

describe('Procedure', () => {
  const procedureContract = TestNamespaceContract.procedures.testProcedure

  it('should create a procedure', () => {
    const handler = () => {}
    const procedure = createContractProcedure(procedureContract, handler)

    expect(kProcedure in procedure).toBe(true)
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
      handler: noopFn,
      dependencies: { dep1, dep2 },
    })

    expect(procedure.dependencies).toHaveProperty('dep1', dep1)
    expect(procedure.dependencies).toHaveProperty('dep2', dep2)
  })

  it('should create a procedure with guards', () => {
    const guard1 = createValueInjectable({ can: () => false })
    const guard2 = createValueInjectable({ can: () => true })

    const procedure = createContractProcedure(procedureContract, {
      handler: noopFn,
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
      handler: noopFn,
      middlewares: [middleware1, middleware2],
    })

    expect([...procedure.middlewares]).toStrictEqual([middleware1, middleware2])
  })

  it('should create a procedure with metadata', () => {
    const metadataKey = createMetadataKey<string>('test')
    const procedure = createContractProcedure(procedureContract, {
      handler: noopFn,
      metadata: [metadataKey.as('some')],
    })

    expect(procedure.metadata.get(metadataKey)).toBe('some')
  })

  it('should create a procedure with handler', () => {
    const handler = () => 'result'
    const procedure = createContractProcedure(procedureContract, handler)

    expect(procedure.handler).toBe(handler)
  })

  it('should create a procedure with iterable response', async () => {
    const stream = type.number()
    const procedure = createProcedure({
      stream,
      handler: async () => {
        return createStreamResponse(
          async function* () {
            for await (const element of [1]) {
              yield element
            }
          },
          {
            output: { test: 'value' },
          },
        )
      },
    })

    expect(kProcedure in procedure).toBe(true)
    expect(procedure.contract).toMatchObject({
      type: 'neemata:procedure',
      input: expect.any(type.NeverType),
      output: expect.any(type.AnyType),
      stream,
      name: undefined,
      namespace: undefined,
      timeout: undefined,
    })
  })
})

describe('Procedure static', () => {
  it('should create a procedure', () => {
    const input = type.string()
    const output = type.object({ a: type.literal('dep1') })
    const dep1 = createValueInjectable('dep1' as const)
    const dep2 = createValueInjectable('dep2')

    const procedure = createProcedure({
      input,
      output,
      dependencies: {
        dep1,
        dep2,
      },
      handler(ctx, data) {
        return { a: ctx.dep1 }
      },
    })

    expect(kProcedure in procedure).toBe(true)
    expect(procedure.contract).toMatchObject({
      type: 'neemata:procedure',
      input,
      output,
      stream: expect.any(type.NeverType),
      name: undefined,
      namespace: undefined,
      timeout: undefined,
    })
  })

  it('should create a procedure without input and output schema', () => {
    const dep1 = createValueInjectable('dep1' as const)
    const dep2 = createValueInjectable('dep2')

    const procedure = createProcedure({
      dependencies: {
        dep1,
        dep2,
      },
      handler(ctx, data) {
        return { a: ctx.dep1 }
      },
    })

    expect(kProcedure in procedure).toBe(true)
    expect(procedure.contract).toMatchObject({
      type: 'neemata:procedure',
      input: expect.any(type.NeverType),
      output: expect.any(type.AnyType),
      stream: expect.any(type.NeverType),
      name: undefined,
      namespace: undefined,
      timeout: undefined,
    })
  })

  it('should create a procedure with iterable response without contract', async () => {
    const procedure = createProcedure({
      stream: true,
      handler: async () => {
        return createStreamResponse(
          async function* () {
            for await (const element of [1]) {
              yield element
            }
          },
          {
            output: { test: 'value' },
          },
        )
      },
    })

    expect(kProcedure in procedure).toBe(true)
    expect(procedure.contract).toMatchObject({
      type: 'neemata:procedure',
      input: expect.any(type.NeverType),
      output: expect.any(type.AnyType),
      stream: expect.any(type.AnyType),
      name: undefined,
      namespace: undefined,
      timeout: undefined,
    })
  })
})
