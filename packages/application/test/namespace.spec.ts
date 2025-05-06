import { noopFn } from '@nmtjs/common'
import {
  createValueInjectable,
  Hook,
  Hooks,
  kHookCollection,
} from '@nmtjs/core'
import { describe, expect, it } from 'vitest'
import { kNamespace } from '../src/constants.ts'
import { createContractNamespace, createNamespace } from '../src/namespace.ts'
import { TestNamespaceContract, testProcedure } from './_utils.ts'

describe('Namespace', () => {
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
    expect(
      namespace.hooks[kHookCollection].get(Hook.AfterInitialize)?.has(handler),
    ).toBe(true)
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

describe('Namespace static', () => {
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
