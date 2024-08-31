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
import { c, t } from '@nmtjs/contract'

import { type AnyProcedure, Procedure } from '../lib/api.ts'
import { Application, type ApplicationOptions } from '../lib/application.ts'
import { Connection, type ConnectionOptions } from '../lib/connection.ts'
import { Hook, WorkerType } from '../lib/constants.ts'
import { createLogger } from '../lib/logger.ts'
import { type Plugin, createPlugin } from '../lib/plugin.ts'
import type { Registry } from '../lib/registry.ts'
import { Service } from '../lib/service.ts'
import { type BaseTaskExecutor, Task } from '../lib/task.ts'

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

export const TestServiceContract = c.service(
  'TestService',
  {
    test: true,
  },
  {
    testProcedure: c.procedure(t.any(), t.any()),
    testUptream: c.procedure(t.object({ test: t.blob() }), t.any()),
    testDownstream: c.procedure(t.any(), t.object({ test: t.blob() })),
    testSubscription: c.subscription(t.any(), t.any(), {
      testEvent: c.event(t.string()),
    })<{ testOption: string }>(),
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
