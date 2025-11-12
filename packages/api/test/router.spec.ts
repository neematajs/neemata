import type { TProcedureContract } from '@nmtjs/contract'
import { noopFn } from '@nmtjs/common'
import { createValueInjectable } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { kRouter } from '../src/constants.ts'
import { createContractProcedure, createProcedure } from '../src/procedure.ts'
import { createContractRouter, createRouter } from '../src/router.ts'
import { TestRouterContract, testProcedure } from './_utils.ts'

describe('Router', () => {
  const routes = {
    testProcedure: createContractProcedure(
      TestRouterContract.routes.testProcedure,
      { handler: noopFn },
    ),
  }

  describe('Runtime', () => {
    it('should create a router', () => {
      const router = createContractRouter(TestRouterContract, { routes })
      expect(router).toHaveProperty('contract', TestRouterContract)
      expect(router).toHaveProperty('middlewares', expect.any(Set))
      expect(router).toHaveProperty('guards', expect.any(Set))
      expect(router).toHaveProperty('routes', expect.any(Object))
      expect(router.routes).toHaveProperty('testProcedure', expect.any(Object))
    })

    it('should create a router with guards', () => {
      const guard = createValueInjectable({ can: () => false })
      const router = createContractRouter(TestRouterContract, {
        routes,
        guards: [guard],
      })
      expect(router.guards).toContain(guard)
    })

    it('should create a router with middlewares', () => {
      const middleware = createValueInjectable({ handle: noopFn })
      const router = createContractRouter(TestRouterContract, {
        routes,
        middlewares: [middleware],
      })
      expect(router.middlewares).toContain(middleware)
    })

    it('should create a router with procedures', () => {
      const procedure = testProcedure(noopFn)
      const router = createContractRouter(TestRouterContract, {
        routes: { testProcedure: procedure },
      })
      expect(router.routes.testProcedure).toBeDefined()
    })
  })

  describe('Typings', () => {
    it('should create a router with correct types', () => {
      const router = createContractRouter(TestRouterContract, { routes })
      expectTypeOf(router.contract.routes.testProcedure).toEqualTypeOf<
        typeof TestRouterContract.routes.testProcedure
      >()
    })
  })
})

describe('router static', () => {
  describe('Runtime', () => {
    it('should create a router', () => {
      const procedure = testProcedure(noopFn)
      const router = createRouter({
        name: 'test',
        routes: { testProcedure: procedure },
      })

      expect(kRouter in router).toBe(true)
      expect(router.contract).toMatchObject({
        type: 'neemata:router',
        name: 'test',
        routes: expect.anything(),
        timeout: undefined,
      })

      expect(router.routes.testProcedure).toBeDefined()
    })
  })

  describe('Typings', () => {
    it('should create a router with correct types', () => {
      const variableProcedure = createProcedure({
        input: t.any(),
        output: t.any(),
        handler: () => {},
      })

      const router = createRouter({
        name: 'test',
        routes: {
          variableProcedure,
          inlineProcedure: createProcedure({
            input: t.any(),
            output: t.any(),
            handler: () => {},
          }),
        },
      })

      expectTypeOf(router.contract.routes.variableProcedure).toEqualTypeOf<
        TProcedureContract<
          t.AnyType,
          t.AnyType,
          undefined,
          'test/variableProcedure'
        >
      >()

      expectTypeOf(router.contract.routes.inlineProcedure).toEqualTypeOf<
        TProcedureContract<
          t.AnyType,
          t.AnyType,
          undefined,
          'test/inlineProcedure'
        >
      >()
    })
  })
})
