import { createPromise, defer, noopFn, onAbort } from '@nmtjs/common'
import { Container, createValueInjectable } from '@nmtjs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kTask } from '../src/constants.ts'
import { AppInjectables } from '../src/injectables.ts'
import { ApplicationRegistry } from '../src/registry.ts'
import { createTask, TasksRunner } from '../src/task.ts'
import {
  testDefaultTimeout,
  testLogger,
  testTask,
  testTaskRunner,
} from './_utils.ts'

describe('Task', () => {
  it('should create a task', () => {
    const task = createTask('test', { handler: noopFn, parser: () => [] })

    expect(kTask in task).toBe(true)
    expect(task).toHaveProperty('name', 'test')
    expect(task).toHaveProperty('handler', noopFn)
    expect(task).toHaveProperty('parser', expect.any(Function))
    expect(task).toHaveProperty('dependencies', {})
  })

  it('should create a task with dependencies', () => {
    const dep1 = createValueInjectable('dep1')
    const dep2 = createValueInjectable('dep2')
    const task = createTask('test', {
      handler: noopFn,
      dependencies: { dep1, dep2 },
    })

    expect(task.dependencies).toHaveProperty('dep1', dep1)
    expect(task.dependencies).toHaveProperty('dep2', dep2)
  })

  it('should create a task with parser', () => {
    const parser = () => [] as const
    const task = createTask('test', { handler: noopFn, parser })
    expect(task.parser).toBe(parser)
  })

  it('should create a task with a handler', () => {
    const handler = () => {}
    const task = createTask('test', handler)
    expect(task.handler).toBe(handler)
  })
})

describe.sequential('Tasks', () => {
  const logger = testLogger()

  let registry: ApplicationRegistry
  let container: Container
  let tasks: TasksRunner

  beforeEach(async () => {
    registry = new ApplicationRegistry({ logger })
    container = new Container({ logger, registry })
    tasks = new TasksRunner(
      { container, registry },
      { timeout: testDefaultTimeout },
    )
    await container.load()
  })

  afterEach(async () => {
    await container.dispose()
  })

  it('should be a tasks', () => {
    expect(tasks).toBeDefined()
    expect(tasks).toBeInstanceOf(TasksRunner)
  })

  it('should execute a task', async () => {
    const task = testTask(() => 'value')
    registry.registerTask(task)
    const execution = tasks.execute(task)
    expect(execution).toHaveProperty('abort', expect.any(Function))
    const result = await execution
    expect(result).toHaveProperty('result', 'value')
  })

  it('should inject context', async () => {
    const injectable = createValueInjectable({})
    const task = testTask({
      dependencies: { dep: injectable },
      handler: (ctx) => ctx,
    })
    registry.registerTask(task)
    const { result } = await tasks.execute(task)
    expect(result).toHaveProperty('dep', injectable.value)
  })

  it('should handle errors', async () => {
    const thrownError = new Error('Test')
    const task = testTask(() => {
      throw thrownError
    })

    registry.registerTask(task)
    const { error } = await tasks.execute(task)
    expect(error).toBe(thrownError)
  })

  it('should inject args', async () => {
    const args = ['arg1', 'arg2']
    const task = testTask((ctx, ...args) => args)
    registry.registerTask(task)
    const { result } = await tasks.execute(task, ...args)
    expect(result).deep.equal(args)
  })

  it('should handle abortion', async () => {
    const future = createPromise<void>()
    const spy = vi.fn(future.resolve)
    const task = testTask({
      dependencies: { signal: AppInjectables.taskAbortSignal },
      handler: ({ signal }) => new Promise(() => onAbort(signal, spy)),
    })

    registry.registerTask(task)
    const execution = tasks.execute(task)
    defer(() => execution.abort(), 1)
    const { error } = await execution
    expect(error).toBeInstanceOf(Error)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('should handle termination', async () => {
    const future = createPromise<void>()
    const spy = vi.fn(future.resolve)
    const task = testTask({
      dependencies: { signal: AppInjectables.taskAbortSignal },
      handler: ({ signal }) => new Promise(() => onAbort(signal, spy)),
    })

    registry.registerTask(task)
    const execution = tasks.execute(task)
    defer(() => execution.abort(), 1)
    const { error } = await execution
    expect(error).toBeInstanceOf(Error)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('should execute with custom runner', async () => {
    const runnerFn = vi.fn()
    const taskRunner = testTaskRunner(runnerFn)
    const tasks = new TasksRunner(
      { container, registry },
      { timeout: testDefaultTimeout, executor: taskRunner },
    )
    const task = testTask(noopFn)
    registry.registerTask(task)
    await tasks.execute(task)
    expect(runnerFn).toHaveBeenCalledOnce()
  })

  it('should run command', async () => {
    const task = testTask({
      handler: (ctx, arg1: number, arg2: number) => [arg1, arg2],
      parser: (args, kwargs) => {
        return [Number.parseInt(args[0]), kwargs.value]
      },
    })

    registry.registerTask(task)
    const { result } = await tasks.command({
      args: [task.name, '1'],
      kwargs: { value: 2 },
    })
    expect(result).toStrictEqual([1, 2])
  })
})
