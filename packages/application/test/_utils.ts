import { expect } from 'vitest'

import { deserialize, serialize } from 'node:v8'
import {
  BaseServerFormat,
  type DecodeRpcContext,
  type EncodeRpcContext,
  type Pattern,
  type Rpc,
  type RpcResponse,
} from '@nmtjs/common'
import { Contract, Type } from '@nmtjs/contract'
import { type AnyProcedure, Procedure } from '../lib/api.ts'
import { Application, type ApplicationOptions } from '../lib/application.ts'
import { Connection, type ConnectionOptions } from '../lib/connection.ts'
import { Hook, WorkerType } from '../lib/constants.ts'
import { createLogger } from '../lib/logger.ts'
import { type Plugin, createPlugin } from '../lib/plugin.ts'
import type { Registry } from '../lib/registry.ts'
import { Service } from '../lib/service.ts'
import { type BaseTaskExecutor, Task } from '../lib/task.ts'

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
  onStartup = () => {},
  onShutdown = () => {},
) =>
  createPlugin('TestTransport', (app) => {
    const { hooks } = app
    onInit()
    hooks.add(Hook.OnStartup, onStartup)
    hooks.add(Hook.OnShutdown, onShutdown)
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

export const TestServiceContract = Contract.Service(
  'TestService',
  {
    test: true,
  },
  {
    testProcedure: Contract.Procedure(Type.Any(), Type.Any()),
    testSubscription: Contract.Subscription(
      Type.Any(),
      Type.Any(),
      Type.Object({ testOption: Type.String() }),
      {
        testEvent: Contract.Event(Type.String()),
      },
    ),
    testUptream: Contract.Procedure(
      Type.Object({ test: Type.Blob() }),
      Type.Any(),
    ),
    testDownstream: Contract.Procedure(
      Type.Any(),
      Type.Object({ test: Type.Blob() }),
    ),
  },
  {
    testEvent: Contract.Event(Type.String()),
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

export const testProcedure = (): AnyProcedure<
  typeof TestServiceContract.procedures.testProcedure
> => new Procedure(TestServiceContract.procedures.testProcedure)

export const testSubscription = () =>
  new Procedure(TestServiceContract.procedures.testSubscription)

export const testTask = () => new Task('test')

export const testTaskRunner = (...args) => new TestTaskExecutor(...args)

export const testService = ({
  procedure = testProcedure(),
  subscription = testSubscription(),
} = {}) =>
  new Service(TestServiceContract)
    .implement('testProcedure', procedure)
    .implement('testSubscription', subscription)

export const expectCopy = (source, targer) => {
  expect(targer).not.toBe(source)
  expect(targer).toEqual(source)
}
