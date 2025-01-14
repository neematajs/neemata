import { describe, expect, it } from 'vitest'

import { Hook, kService } from '../lib/constants.ts'
import { createValueInjectable } from '../lib/container.ts'
import { Hooks } from '../lib/hooks.ts'
import { createContractService, createService } from '../lib/service.ts'
import { noop } from '../lib/utils/functions.ts'
import { TestServiceContract, testProcedure } from './_utils.ts'

describe('Service', () => {
  it('should create a service', () => {
    const service = createContractService(TestServiceContract, {})
    expect(kService in service).toBe(true)
    expect(service).toHaveProperty('contract', TestServiceContract)
    expect(service).toHaveProperty('hooks', expect.any(Hooks))
    expect(service).toHaveProperty('middlewares', expect.any(Set))
    expect(service).toHaveProperty('guards', expect.any(Set))
  })

  it('should create a service with hooks', () => {
    const handler = () => {}
    const service = createContractService(TestServiceContract, {
      hooks: {
        [Hook.AfterInitialize]: [handler],
      },
    })
    expect(service.hooks.collection.get('test')).toContain(handler)
  })

  it('should create a service with autoload', () => {
    const service = createContractService(TestServiceContract, {
      autoload: new URL('file:///'),
    })
    expect(service.hooks.collection.get(Hook.BeforeInitialize)?.size).toBe(1)
  })

  it('should create a service with guards', () => {
    const guard = createValueInjectable({ can: () => false })
    const service = createContractService(TestServiceContract, {
      guards: [guard],
    })
    expect(service.guards).toContain(guard)
  })

  it('should create a service with middlewares', () => {
    const middleware = createValueInjectable({ handle: noop })
    const service = createContractService(TestServiceContract, {
      middlewares: [middleware],
    })
    expect(service.middlewares).toContain(middleware)
  })

  it('should create a service with procedures', () => {
    const procedure = testProcedure(noop)
    const service = createContractService(TestServiceContract, {
      procedures: { testProcedure: procedure },
    })
    expect(service.procedures.get('testProcedure')).toBe(procedure)
  })
})

describe('Service static', () => {
  it('should create a service', () => {
    const procedure = testProcedure(noop)
    const service = createService({
      name: 'test',
      transports: { test: true },
      procedures: { testProcedure: procedure },
    })

    expect(kService in service).toBe(true)
    expect(service.contract).toMatchObject({
      type: 'neemata:service',
      name: 'test',
      procedures: expect.anything(),
      transports: { test: true },
      events: {},
      timeout: undefined,
    })

    expect(service.procedures.has('testProcedure')).toBe(true)
  })
})
