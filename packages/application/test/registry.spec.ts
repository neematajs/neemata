import { beforeEach, describe, expect, it } from 'vitest'

import { Kind } from '@neematajs/contract'
import { Scope } from '../lib/constants'
import { Provider } from '../lib/container'
import { Registry } from '../lib/registry'
import { noop } from '../lib/utils/functions'
import { testLogger, testProcedure, testService, testTask } from './_utils'

describe('Registry', () => {
  const logger = testLogger()
  let registry: Registry

  beforeEach(() => {
    registry = new Registry({ logger })
  })

  it('should be a registry', () => {
    expect(registry).toBeDefined()
    expect(registry).toBeInstanceOf(Registry)
  })

  it('should load', async () => {
    const service = testService()
    registry.services.set(service.contract.name, service)
    await registry.load()
  })

  it('should compile schemas', async () => {
    const service = testService()
    registry.services.set(service.contract.name, service)
    await registry.load()
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

  it('should fail to register task without handler', () => {
    const task = testTask()
    expect(() => registry.registerTask(task)).toThrow()
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
