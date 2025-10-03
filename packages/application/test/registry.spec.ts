import { noopFn } from '@nmtjs/common'
import { createLazyInjectable, Scope } from '@nmtjs/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { ApplicationRegistry } from '../src/registry.ts'
import { testApp, testRouter, testTask } from './_utils.ts'

describe('ApplicationRegistry', () => {
  let registry: ApplicationRegistry

  beforeEach(() => {
    const app = testApp()
    registry = app.registry
  })

  it('should be a registry', () => {
    expect(registry).toBeDefined()
    expect(registry).toBeInstanceOf(ApplicationRegistry)
  })

  it('should register a router', async () => {
    const router = testRouter()
    registry.registerRouter(router)
    const registeredProcedure = registry.procedures.get(
      router.routes.testProcedure.contract.name,
    )
    expect(registeredProcedure).toHaveProperty(
      'procedure',
      router.routes.testProcedure,
    )
    expect(registeredProcedure).toHaveProperty('path', [router])
  })

  it('should fail to register service with the same contract twice', () => {
    const router1 = testRouter()
    const router2 = testRouter()
    registry.registerRouter(router1)
    expect(() => registry.registerRouter(router2)).toThrow()
  })

  it('should register a task', () => {
    const task = testTask(noopFn)
    registry.registerTask(task)
    expect(registry.tasks.get(task.name)).toBe(task)
  })

  it('should fail to register a task with the same name', () => {
    const task1 = testTask(noopFn)
    const task2 = testTask(noopFn)
    registry.registerTask(task1)
    expect(() => registry.registerTask(task2)).toThrow()
  })

  it('should fail to register a task with non-global dependencies', () => {
    const injectable = createLazyInjectable(Scope.Connection)
    const task = testTask({ dependencies: { injectable }, handler: noopFn })
    expect(() => registry.registerTask(task)).toThrow()
  })
})
