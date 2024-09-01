import { describe, expect, it } from 'vitest'
import { Hook, ServiceKey } from '../lib/constants.ts'
import { createValueInjectable } from '../lib/container.ts'
import { Hooks } from '../lib/hooks.ts'
import { createContractService } from '../lib/service.ts'
import { noop } from '../lib/utils/functions.ts'
import { TestServiceContract, testProcedure, testService } from './_utils.ts'

describe('Service', () => {
  it('should create a service', () => {
    const service = createContractService(TestServiceContract, {})
    expect(ServiceKey in service).toBe(true)
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
