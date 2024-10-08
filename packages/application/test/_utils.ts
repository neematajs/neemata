import { expect } from 'vitest'

import { deserialize, serialize } from 'node:v8'
import {
  BaseServerFormat,
  type DecodeRpcContext,
  type EncodeRpcContext,
  type Pattern,
  type Rpc,
  type RpcResponse,
  type TypeProvider,
} from '@nmtjs/common'
import { c } from '@nmtjs/contract'
import { t } from '@nmtjs/type'

import { Application, type ApplicationOptions } from '../lib/application.ts'
import { Connection, type ConnectionOptions } from '../lib/connection.ts'
import { Hook, WorkerType } from '../lib/constants.ts'
import type { Dependencies } from '../lib/container.ts'
import { createLogger } from '../lib/logger.ts'
import { type Plugin, createPlugin } from '../lib/plugin.ts'
import {
  type CreateProcedureParams,
  createContractProcedure,
} from '../lib/procedure.ts'
import type { Registry } from '../lib/registry.ts'
import { createContractService } from '../lib/service.ts'
import {
  type BaseTaskExecutor,
  type CreateTaskOptions,
  createTask,
} from '../lib/task.ts'
import { createTransport } from '../lib/transport.ts'
import { noop } from '../lib/utils/functions.ts'

export interface TestTypeProvider extends TypeProvider {
  input: 1 | 2 | 'string'
  output: this['input']
}

export class TestFormat extends BaseServerFormat {
  accept: Pattern[] = [
    'test',
    '*es*',
    '*test',
    'test*',
    (t) => t === 'test',
    /test/,
  ]
  contentType = 'test'

  encode(data: any): ArrayBuffer {
    return serialize(data).buffer as ArrayBuffer
  }

  encodeRpc(rpc: RpcResponse, context: EncodeRpcContext): ArrayBuffer {
    return this.encode(rpc)
  }

  decode(buffer: ArrayBuffer): any {
    return deserialize(Buffer.from(buffer))
  }

  decodeRpc(buffer: ArrayBuffer, context: DecodeRpcContext): Rpc {
    const [callId, service, procedure, payload] = this.decode(buffer)
    return { callId, service, procedure, payload }
  }
}

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
) =>
  createTransport('TestTransport', (app) => {
    onInit()
    return {
      start: onStartup,
      stop: onShutdown,
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

export const TestServiceContract = c.service(
  'TestService',
  {
    test: true,
  },
  {
    testProcedure: c.procedure(t.any(), t.any()),
    testUptream: c.procedure(t.object({ test: c.blob() }), t.any()),
    testDownstream: c.procedure(t.any(), t.object({ test: c.blob() })),
    testSubscription: c
      .subscription(t.any(), t.any(), {
        testEvent: c.event(t.string()),
      })
      .$withOptions<{ testOption: string }>(),
  },
  {
    testEvent: c.event(t.string()),
  },
)

export const testConnection = (
  registry: Registry,
  options: Partial<ConnectionOptions> = {},
) => {
  return new Connection(
    {
      ...options,
      type: 'test',
      services: ['TestService'],
    },
    registry,
  )
}

export const testFormat = () => new TestFormat()

export const testProcedure = (
  params: CreateProcedureParams<
    typeof TestServiceContract.procedures.testProcedure,
    any
  >,
) =>
  createContractProcedure(TestServiceContract.procedures.testProcedure, params)

export const testSubscription = (
  params: CreateProcedureParams<
    typeof TestServiceContract.procedures.testSubscription,
    any
  >,
) =>
  createContractProcedure(
    TestServiceContract.procedures.testSubscription,
    params,
  )

export const testTask = <
  TaskDeps extends Dependencies,
  TaskArgs extends any[],
  TaskResult,
>(
  options: CreateTaskOptions<TaskDeps, TaskArgs, TaskResult>,
) => createTask('test', options)

export const testTaskRunner = (...args) => new TestTaskExecutor(...args)

export const testService = ({
  procedure = testProcedure(noop),
  subscription = testSubscription(noop as any),
} = {}) =>
  createContractService(TestServiceContract, {
    procedures: {
      testProcedure: procedure,
      testSubscription: subscription,
    },
  })

export const expectCopy = (source, targer) => {
  expect(targer).not.toBe(source)
  expect(targer).toEqual(source)
}
