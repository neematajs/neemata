import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Container, Provider } from '../lib/container.ts'
import { Registry } from '../lib/registry.ts'
import { Task, Tasks } from '../lib/tasks.ts'
import { createFuture, defer, noop, onAbort } from '../lib/utils/functions.ts'
import {
  testDefaultTimeout,
  testLogger,
  testTask,
  testTaskRunner,
} from './_utils.ts'

describe.sequential('Task', () => {
  let task: Task

  beforeEach(() => {
    task = testTask().withHandler(noop)
  })

  it('should be a task', () => {
    expect(task).toBeDefined()
    expect(task).toBeInstanceOf(Task)
  })

  it('should clone with a handler', () => {
    const handler = () => {}
    const newTask = task.withHandler(handler)
    expect(newTask.handler).toBe(handler)
    expect(newTask).not.toBe(task)
  })

  it('should clone with a parser', () => {
    const parser = (...args: any[]): any => {}
    const newTask = task.withParser(parser)
    expect(newTask.parser).toBe(parser)
    expect(newTask).not.toBe(task)
  })

  it('should clone with a dependencies', () => {
    const dep1 = new Provider().withValue('dep1')
    const dep2 = new Provider().withValue('dep2')
    const newTask = task.withDependencies({
      dep1,
    })
    const newTask2 = newTask.withDependencies({
      dep2,
    })
    expect(newTask2.dependencies).toHaveProperty('dep1', dep1)
    expect(newTask2.dependencies).toHaveProperty('dep2', dep2)
    expect(newTask2).not.toBe(task)
  })
})

describe.sequential('Tasks', () => {
  const logger = testLogger()

  let registry: Registry
  let container: Container
  let tasks: Tasks

  beforeEach(async () => {
    registry = new Registry({ logger })
    container = new Container({ logger, registry })
    tasks = new Tasks({ container, registry }, { timeout: testDefaultTimeout })
    await container.load()
  })

  afterEach(async () => {
    await container.dispose()
  })

  it('should be a tasks', () => {
    expect(tasks).toBeDefined()
    expect(tasks).toBeInstanceOf(Tasks)
  })

  it('should execute a task', async () => {
    const task = testTask().withHandler(() => 'value')
    registry.registerTask(task)
    const execution = tasks.execute(task)
    expect(execution).toHaveProperty('abort', expect.any(Function))
    const result = await execution
    expect(result).toHaveProperty('result', 'value')
  })

  it('should inject context', async () => {
    const provider = new Provider().withValue({})
    const task = testTask()
      .withDependencies({ dep: provider })
      .withHandler((ctx) => ctx)
    registry.registerTask(task)
    const { result } = await tasks.execute(task)
    expect(result).toHaveProperty('dep', provider.value)
  })

  it('should handle errors', async () => {
    const thrownError = new Error('Test')
    const task = testTask().withHandler(() => {
      throw thrownError
    })

    registry.registerTask(task)
    const { error } = await tasks.execute(task)
    expect(error).toBe(thrownError)
  })

  it('should inject args', async () => {
    const args = ['arg1', 'arg2']
    const task = testTask().withHandler((ctx, ...args) => args)
    registry.registerTask(task)
    const { result } = await tasks.execute(task, ...args)
    expect(result).deep.equal(args)
  })

  it('should inject args', async () => {
    const args = ['arg1', 'arg2']
    const task = testTask().withHandler((ctx, ...args) => args)
    registry.registerTask(task)
    const { result } = await tasks.execute(task, ...args)
    expect(result).deep.equal(args)
  })

  it('should handle abortion', async () => {
    const future = createFuture<void>()
    const spy = vi.fn(future.resolve)
    const task = testTask()
      .withDependencies({ signal: Task.signal })
      .withHandler(({ signal }) => new Promise(() => onAbort(signal, spy)))

    registry.registerTask(task)
    const execution = tasks.execute(task)
    defer(() => execution.abort(), 1)
    const { error } = await execution
    expect(error).toBeInstanceOf(Error)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('should handle termination', async () => {
    const future = createFuture<void>()
    const spy = vi.fn(future.resolve)
    const task = testTask()
      .withDependencies({ signal: Task.signal })
      .withHandler(({ signal }) => new Promise(() => onAbort(signal, spy)))

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
    const tasks = new Tasks(
      { container, registry },
      { timeout: testDefaultTimeout, runner: taskRunner },
    )
    const task = testTask().withHandler(noop)
    registry.registerTask(task)
    await tasks.execute(task)
    expect(runnerFn).toHaveBeenCalledOnce()
  })

  it('should run command', async () => {
    const task = testTask()
      .withHandler((ctx, arg1: number, arg2: number) => [arg1, arg2])
      .withParser((args, kwargs) => {
        return [Number.parseInt(args[0]), kwargs.value]
      })

    registry.registerTask(task)
    const { result } = await tasks.command({
      args: [task.name, '1'],
      kwargs: { value: 2 },
    })
    expect(result).toStrictEqual([1, 2])
  })
})
