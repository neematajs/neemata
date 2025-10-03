import { noopFn } from '@nmtjs/common'
import { createLazyInjectable, Scope } from '@nmtjs/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { ApplicationRegistry } from '../src/registry.ts'
import { createRouter } from '../src/router.ts'
import { testApp, testNamepsace, testTask } from './_utils.ts'

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

  it('should register router', async () => {
    const namespace = testNamepsace()
    const router = createRouter({ namespace })
    registry.registerRouter(router)
    expect(registry.namespaces.get(namespace.contract.name)).toBe(namespace)
  })

  it('should fail to register service with the same contract twice', () => {
    const namespace1 = testNamepsace()
    const namespace2 = testNamepsace()
    const router1 = createRouter({ namespace: namespace1 })
    const router2 = createRouter({ namespace: namespace2 })
    registry.registerRouter(router1)
    expect(() => registry.registerRouter(router2)).toThrow()
  })

  it('should register task', () => {
    const task = testTask(noopFn)
    registry.registerTask(task)
    expect(registry.tasks.get(task.name)).toBe(task)
  })

  it('should fail to register task with the same name', () => {
    const task1 = testTask(noopFn)
    const task2 = testTask(noopFn)
    registry.registerTask(task1)
    expect(() => registry.registerTask(task2)).toThrow()
  })

  it('should fail register task with non-global dependencies', () => {
    const injectable = createLazyInjectable(Scope.Connection)
    const task = testTask({ dependencies: { injectable }, handler: noopFn })
    expect(() => registry.registerTask(task)).toThrow()
  })
})
