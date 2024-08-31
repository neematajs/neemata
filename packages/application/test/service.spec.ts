import { beforeEach, describe, expect, it } from 'vitest'
import { Hook } from '../lib/constants.ts'
import { createValueInjectable } from '../lib/container.ts'
import { Hooks } from '../lib/hooks.ts'
import { Service } from '../lib/service.ts'
import { noop } from '../lib/utils/functions.ts'
import {
  type TestServiceContract,
  testProcedure,
  testService,
} from './_utils.ts'

describe('Service', () => {
  let service: Service<typeof TestServiceContract>

  beforeEach(() => {
    service = testService()
  })

  it('should be defined', () => {
    expect(service).toBeInstanceOf(Service)
  })

  it('should have a contract', () => {
    expect(service.contract).toBeDefined()
  })

  it('should have hooks', () => {
    expect(service.hooks).toBeInstanceOf(Hooks)
    const handler = () => {}
    service.withHook(Hook.AfterInitialize, handler)
    expect(service.hooks.collection.get('test')).toContain(handler)
  })

  it('should have middlewares', () => {
    expect(service.middlewares).toBeInstanceOf(Set)
    const middleware = createValueInjectable({ handle: noop })
    service.withMiddleware(middleware)
    expect(service.middlewares).toContain(middleware)
  })

  it('should have guards', () => {
    expect(service.guards).toBeInstanceOf(Set)
    const guard = createValueInjectable({ can: () => false })
    service.withGuard(guard)
    expect(service.guards).toContain(guard)
  })

  it('should have procedures', () => {
    expect(service.procedures).toBeInstanceOf(Map)
  })

  it('should implement a procedure', () => {
    const procedure = testProcedure()
    service.implement('testProcedure', procedure)
    expect(service.procedures.get('testProcedure')).toBe(procedure)
  })
})
