import type { Dependencies, Plugin } from '@nmtjs/core'
import type { ConnectionOptions } from '@nmtjs/protocol/server'
import { noopFn } from '@nmtjs/common'
import { c } from '@nmtjs/contract'
import { createLogger, createPlugin } from '@nmtjs/core'
import { Connection, createTransport } from '@nmtjs/protocol/server'
import { t } from '@nmtjs/type'
import { expect } from 'vitest'

import type { ApplicationOptions } from '../src/application.ts'
import type { CreateProcedureParams } from '../src/procedure.ts'
import type { BaseTaskExecutor, CreateTaskOptions } from '../src/tasks.ts'
import { Application } from '../src/application.ts'
import { WorkerType } from '../src/enums.ts'
import { createContractProcedure } from '../src/procedure.ts'
import { createContractRouter } from '../src/router.ts'
import { createTask } from '../src/tasks.ts'

export class TestTaskExecutor implements BaseTaskExecutor {
  constructor(
    private readonly custom?: (task: any, ...args: any[]) => Promise<any>,
  ) {}

  execute(_signal: AbortSignal, name: string, ...args: any[]): Promise<any> {
    return this.custom ? this.custom(name, ...args) : Promise.resolve()
  }
}

export const testTransport = (
  onInit = () => {},
  onStartup = async () => {},
  onShutdown = async () => {},
  onSend = async () => {},
) =>
  createTransport('TestTransport', () => {
    onInit()
    return { start: onStartup, stop: onShutdown, send: onSend }
  })

export const testDefaultTimeout = 1000

export const testPlugin = (init: Plugin['init'] = () => {}) =>
  createPlugin('TestPlugin', init)

export const testLogger = () =>
  createLogger({ pinoOptions: { enabled: false } }, 'test')

export const testApp = (options: Partial<ApplicationOptions> = {}) =>
  new Application(
    Object.assign(
      {
        type: WorkerType.Api,
        api: { timeout: testDefaultTimeout, formats: [] },
        tasks: { timeout: testDefaultTimeout },
        logging: { pinoOptions: { enabled: false } },
        pubsub: {},
      } as ApplicationOptions,
      options,
    ),
  )

export const TestRouterContract = c.router({
  routes: { testProcedure: c.procedure({ input: t.any(), output: t.any() }) },
  events: { testEvent: c.event({ payload: t.string() }) },
  name: 'TestRouter',
})

export const testConnection = (options: ConnectionOptions = { data: {} }) => {
  return new Connection(options)
}

export const testProcedure = (
  params: CreateProcedureParams<
    typeof TestRouterContract.routes.testProcedure,
    any
  >,
) => createContractProcedure(TestRouterContract.routes.testProcedure, params)

export const testTask = <
  TaskDeps extends Dependencies,
  TaskArgs extends any[],
  TaskResult,
>(
  options: CreateTaskOptions<TaskDeps, TaskArgs, TaskResult>,
) => createTask('test', options)

export const testTaskRunner = (...args) => new TestTaskExecutor(...args)

export const testRouter = (option?: {
  routes: { testProcedure: ReturnType<typeof testProcedure> }
}) =>
  createContractRouter(TestRouterContract, {
    routes: { testProcedure: testProcedure(noopFn), ...option?.routes },
  })

export const expectCopy = (source, targer) => {
  expect(targer).not.toBe(source)
  expect(targer).toEqual(source)
}
