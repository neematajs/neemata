import { beforeEach, describe, expect, it } from 'vitest'

import { Kind } from '@nmtjs/contract'
import { Scope } from '../lib/constants.ts'
import { Provider } from '../lib/container.ts'
import { Registry } from '../lib/registry.ts'
import { noop } from '../lib/utils/functions.ts'
import { testApp, testService, testTask } from './_utils.ts'

describe('Registry', () => {
  let registry: Registry

  beforeEach(() => {
    const app = testApp()
    registry = app.registry
  })

  it('should be a registry', () => {
    expect(registry).toBeDefined()
    expect(registry).toBeInstanceOf(Registry)
  })

  it('should register service', async () => {
    const service = testService()
    registry.registerService(service)
    expect(registry.services.get(service.contract.name)).toBe(service)
  })

  it('should compile schemas', async () => {
    const service = testService()
    registry.registerService(service)
    expect(registry.schemas.size).toBeGreaterThan(0)
    for (const [schema, compiled] of registry.schemas) {
      expect(schema[Kind]).toBeDefined()
      expect(compiled).toMatchObject({
        check: expect.any(Function),
        encode: expect.any(Function),
        decode: expect.any(Function),
      })
    }
    expect(
      registry.schemas.has(service.contract.procedures.testProcedure.input),
    ).toBe(true)
    expect(
      registry.schemas.has(service.contract.procedures.testProcedure.output),
    ).toBe(true)
  })

  it('should register service', () => {
    const service = testService()
    registry.registerService(service)
    expect(registry.services.get(service.contract.name)).toBe(service)
  })

  it('should fail to register service with the same contract twice', () => {
    const service1 = testService()
    const service2 = testService()
    registry.registerService(service1)
    expect(() => registry.registerService(service2)).toThrow()
  })

  it('should register task', () => {
    const task = testTask().withHandler(noop)
    registry.registerTask(task)
    expect(registry.tasks.get(task.name)).toBe(task)
  })

  it('should fail to register task with the same name', () => {
    const task1 = testTask().withHandler(noop)
    const task2 = testTask().withHandler(noop)
    registry.registerTask(task1)
    expect(() => registry.registerTask(task2)).toThrow()
  })

  it('should fail register task with non-global dependencies', () => {
    const provider = new Provider().withScope(Scope.Connection)
    const task = testTask().withHandler(noop).withDependencies({ provider })
    expect(() => registry.registerTask(task)).toThrow()
  })
})
