import { expect, test } from 'vitest'

import { deserialize, serialize } from 'node:v8'
import { BaseServerFormat, type DecodeRpcContext } from '@neematajs/common'
import { Contract } from '@neematajs/contract'
import { Procedure } from '../lib/api'
import { Application, type ApplicationOptions } from '../lib/application'
import { WorkerType } from '../lib/constants'
import { BaseExtension } from '../lib/extension'
import { createLogger } from '../lib/logger'
import type { Registry } from '../lib/registry'
import { Service } from '../lib/service'
import { BaseTaskRunner, Task } from '../lib/tasks'
import { BaseTransport, BaseTransportConnection } from '../lib/transport'

export class TestFormat extends BaseServerFormat {
  accepts = ['test']
  mime = 'test'

  encode(data: any): ArrayBuffer {
    return serialize(data).buffer as ArrayBuffer
  }

  decode(buffer: ArrayBuffer): any {
    return deserialize(Buffer.from(buffer))
  }

  decodeRpc(
    buffer: ArrayBuffer,
    context: DecodeRpcContext,
  ): { callId: number; name: string; payload: any } {
    const [callId, name, payload] = this.decode(buffer)
    return { callId, name, payload }
  }
}

export class TestConnection<D> extends BaseTransportConnection {
  readonly transport = 'test'

  constructor(
    registry: Registry,
    readonly data: D,
  ) {
    super(registry, new Set(['TestService']))
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
      Contract.Object({ test: Contract.String() }),
      Contract.Any(),
    ),
    testSubscription: Contract.Procedure(
      Contract.Object({ test: Contract.String() }),
      Contract.Subscription(
        Contract.Object({ testOption: Contract.String() }),
        {
          testEvent: Contract.String(),
        },
      ),
    ),
  },
  {
    testEvent: Contract.Event(Contract.String()),
  },
)

export const testConnection = <T = {}>(registry: Registry, data?: T) => {
  return new TestConnection(registry, data ?? {})
}

export const testFormat = () => new TestFormat()

export const testProcedure = () =>
  new Procedure(TestServiceContract, 'testProcedure')

export const testSubscription = () =>
  new Procedure(TestServiceContract, 'testSubscription')

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
