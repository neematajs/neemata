import { noopFn } from '@nmtjs/common'
import type { TProcedureContract } from '@nmtjs/contract'
import {
  createValueInjectable,
  Hook,
  Hooks,
  kHookCollection,
} from '@nmtjs/core'
import type from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { kNamespace } from '../src/constants.ts'
import { createContractNamespace, createNamespace } from '../src/namespace.ts'
import { createProcedure } from '../src/procedure.ts'
import { TestNamespaceContract, testProcedure } from './_utils.ts'

describe('Namespace', () => {
  describe('Runtime', () => {
    it('should create a namespace', () => {
      const namespace = createContractNamespace(TestNamespaceContract, {})
      expect(kNamespace in namespace).toBe(true)
      expect(namespace).toHaveProperty('contract', TestNamespaceContract)
      expect(namespace).toHaveProperty('hooks', expect.any(Hooks))
      expect(namespace).toHaveProperty('middlewares', expect.any(Set))
      expect(namespace).toHaveProperty('guards', expect.any(Set))
    })

    it('should create a namespace with hooks', () => {
      const handler = () => {}
      const namespace = createContractNamespace(TestNamespaceContract, {
        hooks: {
          [Hook.AfterInitialize]: [handler],
        },
      })
      expect(namespace.hooks[kHookCollection].get('test')).toContain(handler)
    })

    it('should create a namespace with autoload', () => {
      const namespace = createContractNamespace(TestNamespaceContract, {
        autoload: new URL('file:///'),
      })
      expect(
        namespace.hooks[kHookCollection].get(Hook.BeforeInitialize)?.size,
      ).toBe(1)
    })

    it('should create a namespace with guards', () => {
      const guard = createValueInjectable({ can: () => false })
      const namespace = createContractNamespace(TestNamespaceContract, {
        guards: [guard],
      })
      expect(namespace.guards).toContain(guard)
    })

    it('should create a namespace with middlewares', () => {
      const middleware = createValueInjectable({ handle: noopFn })
      const namespace = createContractNamespace(TestNamespaceContract, {
        middlewares: [middleware],
      })
      expect(namespace.middlewares).toContain(middleware)
    })

    it('should create a namespace with procedures', () => {
      const procedure = testProcedure(noopFn)
      const namespace = createContractNamespace(TestNamespaceContract, {
        procedures: { testProcedure: procedure },
      })
      expect(namespace.procedures.get('testProcedure')).toBe(procedure)
    })
  })

  describe('Typings', () => {
    it('should create a namespace with correct types', () => {
      const namespace = createContractNamespace(TestNamespaceContract)
      expectTypeOf(namespace.contract.procedures.testProcedure).toEqualTypeOf<
        typeof TestNamespaceContract.procedures.testProcedure
      >()
      expectTypeOf(namespace.contract.events.testEvent).toEqualTypeOf<
        typeof TestNamespaceContract.events.testEvent
      >()
    })
  })
})

describe('Namespace static', () => {
  describe('Runtime', () => {
    it('should create a namespace', () => {
      const procedure = testProcedure(noopFn)
      const namespace = createNamespace({
        name: 'test',
        procedures: { testProcedure: procedure },
      })

      expect(kNamespace in namespace).toBe(true)
      expect(namespace.contract).toMatchObject({
        type: 'neemata:namespace',
        name: 'test',
        procedures: expect.anything(),
        events: {},
        timeout: undefined,
      })

      expect(namespace.procedures.has('testProcedure')).toBe(true)
    })
  })

  describe('Typings', () => {
    it('should create a namespace with correct types', () => {
      const variableProcedure = createProcedure({
        input: type.any(),
        output: type.any(),
        handler: () => {},
      })

      const namespace = createNamespace({
        name: 'test',
        procedures: {
          variableProcedure,
          inlineProcedure: createProcedure({
            input: type.any(),
            output: type.any(),
            handler: () => {},
          }),
        },
      })

      expectTypeOf(
        namespace.contract.procedures.variableProcedure,
      ).toEqualTypeOf<
        TProcedureContract<
          type.AnyType,
          type.AnyType,
          undefined,
          'variableProcedure',
          'test'
        >
      >()

      expectTypeOf(namespace.contract.procedures.inlineProcedure).toEqualTypeOf<
        TProcedureContract<
          type.AnyType,
          type.AnyType,
          undefined,
          'inlineProcedure',
          'test'
        >
      >()
    })
  })
})
