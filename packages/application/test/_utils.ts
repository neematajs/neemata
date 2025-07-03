import { noopFn } from '@nmtjs/common'

import { c } from '@nmtjs/contract'
import {
  createLogger,
  createPlugin,
  type Dependencies,
  type Plugin,
} from '@nmtjs/core'
import {
  Connection,
  type ConnectionOptions,
  createTransport,
} from '@nmtjs/protocol/server'
import { t } from '@nmtjs/type'
import { expect } from 'vitest'
import { Application, type ApplicationOptions } from '../src/application.ts'
import { WorkerType } from '../src/enums.ts'
import { createContractNamespace } from '../src/namespace.ts'
import {
  type CreateProcedureParams,
  createContractProcedure,
} from '../src/procedure.ts'
import {
  type BaseTaskExecutor,
  type CreateTaskOptions,
  createTask,
} from '../src/task.ts'

export class TestTaskExecutor implements BaseTaskExecutor {
  constructor(
    private readonly custom?: (task: any, ...args: any[]) => Promise<any>,
  ) {}

  execute(signal: AbortSignal, name: string, ...args: any[]): Promise<any> {
    return this.custom ? this.custom(name, ...args) : Promise.resolve()
  }
}

export const testTransport = (
  onInit = () => {},
  onStartup = async () => {},
  onShutdown = async () => {},
  onSend = async () => {},
) =>
  createTransport('TestTransport', (app) => {
    onInit()
    return {
      start: onStartup,
      stop: onShutdown,
      send: onSend,
    }
  })

export const testDefaultTimeout = 1000

export const testPlugin = (init: Plugin['init'] = () => {}) =>
  createPlugin('TestPlugin', init)

export const testLogger = () =>
  createLogger(
    {
      pinoOptions: { enabled: false },
    },
    'test',
  )

export const testApp = (options: Partial<ApplicationOptions> = {}) =>
  new Application(
    Object.assign(
      {
        type: WorkerType.Api,
        api: {
          timeout: testDefaultTimeout,
          formats: [],
        },
        tasks: {
          timeout: testDefaultTimeout,
        },
        logging: {
          pinoOptions: { enabled: false },
        },
      },
      options,
    ),
  )

export const TestNamespaceContract = c.namespace({
  procedures: {
    testProcedure: c.procedure({
      input: t.any(),
      output: t.any(),
    }),
    testUptream: c.procedure({
      input: t.object({ test: c.blob() }),
      output: t.any(),
      stream: t.never(),
    }),
    testDownstream: c.procedure({
      input: t.any(),
      output: t.object({ test: c.blob() }),
      stream: t.never(),
    }),
  },
  subscriptions: {
    // testSubscription: c
    //   .subscription({
    //     input: t.any(),
    //     output: t.any(),
    //     events: {
    //       testEvent: c.event({
    //         payload: t.string(),
    //       }),
    //     },
    //   })
    //   .$withOptions<{ testOption: string }>(),
  },
  events: {
    testEvent: c.event({
      payload: t.string(),
    }),
  },
  name: 'TestNamespace',
})

export const testConnection = (options: ConnectionOptions = { data: {} }) => {
  return new Connection(options)
}

export const testProcedure = (
  params: CreateProcedureParams<
    typeof TestNamespaceContract.procedures.testProcedure,
    any
  >,
) =>
  createContractProcedure(
    TestNamespaceContract.procedures.testProcedure,
    params,
  )

// export const testSubscription = (
//   params: CreateProcedureParams<
//     typeof TestNamespaceContract.subscriptions.testSubscription,
//     any
//   >,
// ) =>
//   createContractProcedure(
//     TestNamespaceContract.subscriptions.testSubscription,
//     params,
//   ) as any

export const testTask = <
  TaskDeps extends Dependencies,
  TaskArgs extends any[],
  TaskResult,
>(
  options: CreateTaskOptions<TaskDeps, TaskArgs, TaskResult>,
) => createTask('test', options)

export const testTaskRunner = (...args) => new TestTaskExecutor(...args)

export const testNamepsace = ({
  procedure = testProcedure(noopFn),
  // subscription = testSubscription(noop as any),
} = {}) =>
  createContractNamespace(TestNamespaceContract, {
    procedures: {
      testProcedure: procedure,
    },
    subscriptions: {
      // testSubscription: subscription,
    },
  })

export const expectCopy = (source, targer) => {
  expect(targer).not.toBe(source)
  expect(targer).toEqual(source)
}
