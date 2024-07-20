import { expect, test } from 'vitest'

import { deserialize, serialize } from 'node:v8'
import {
  BaseServerFormat,
  type DecodeRpcContext,
  type Rpc,
  StreamDataType,
} from '@neematajs/common'
import { Contract, Type } from '@neematajs/contract'
import { Procedure } from '../lib/api.ts'
import { Application, type ApplicationOptions } from '../lib/application.ts'
import { WorkerType } from '../lib/constants.ts'
import { BaseExtension } from '../lib/extension.ts'
import { createLogger } from '../lib/logger.ts'
import type { Registry } from '../lib/registry.ts'
import { Service } from '../lib/service.ts'
import { BaseTaskRunner, Task } from '../lib/tasks.ts'
import { BaseTransport, BaseTransportConnection } from '../lib/transport.ts'

export class TestFormat extends BaseServerFormat {
  accepts = ['test']
  mime = 'test'

  encode(data: any): ArrayBuffer {
    return serialize(data).buffer as ArrayBuffer
  }

  decode(buffer: ArrayBuffer): any {
    return deserialize(Buffer.from(buffer))
  }

  decodeRpc(buffer: ArrayBuffer, context: DecodeRpcContext): Rpc {
    const [callId, service, procedure, payload] = this.decode(buffer)
    return { callId, service, procedure, payload }
  }
}

export class TestConnection<D> extends BaseTransportConnection {
  readonly transport = 'test'

  constructor(
    registry: Registry,
    readonly data: D,
  ) {
    super(registry, ['TestService'])
  }

  protected sendEvent() {
    return false
  }
}

export class TestTaskRunner extends BaseTaskRunner {
  constructor(
    private readonly custom?: (task: any, ...args: any[]) => Promise<any>,
  ) {
    super()
  }

  execute(signal: AbortSignal, name: string, ...args: any[]): Promise<any> {
    return this.custom ? this.custom(name, ...args) : Promise.resolve()
  }
}

export class TestExtension extends BaseExtension {
  name = 'Test extension'
}

export class TestTransport extends BaseTransport<'test', TestConnection<any>> {
  readonly type = 'test' as const

  // biome-ignore lint/complexity/noUselessConstructor:
  constructor(...args: any[]) {
    // @ts-expect-error
    super(...args)
  }

  name = 'Test transport'

  async start() {
    return true
  }

  async stop() {
    return true
  }
}

export const testDefaultTimeout = 1000

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
    testProcedure: Contract.Procedure(
      Type.Object({ test: Type.String() }),
      Type.Any(),
    ),
    testSubscription: Contract.Subscription(
      Type.Object({ test: Type.String() }),
      Type.Never(),
      Type.Object({ testOption: Type.String() }),
      {
        testEvent: Contract.Event(Type.String()),
      },
    ),
    testBinaryStream: Contract.Procedure(
      Type.Object({ test: Type.String() }),
      Contract.DownStream(
        StreamDataType.Binary,
        Type.Object({ test: Type.String() }),
      ),
    ),
    testEncodedStream: Contract.Procedure(
      Type.Object({ test: Type.String() }),
      Contract.DownStream(
        StreamDataType.Encoded,
        Type.Object({ test: Type.String() }),
        Type.Object({ test: Type.String() }),
      ),
    ),
  },
  {
    testEvent: Contract.Event(Type.String()),
  },
)

export const testConnection = <T = {}>(registry: Registry, data?: T) => {
  return new TestConnection(registry, data ?? {})
}

export const testFormat = () => new TestFormat()

export const testProcedure = () =>
  new Procedure(TestServiceContract.procedures.testProcedure)

export const testSubscription = () =>
  new Procedure(TestServiceContract.procedures.testSubscription)

export const testTask = () => new Task().withName('test')

export const testTaskRunner = (...args) => new TestTaskRunner(...args)

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
