import { expect } from 'vitest'

import { deserialize, serialize } from 'node:v8'
import { BaseServerFormat, type DecodeRpcContext } from '@neematajs/common'
import { BaseParser, Procedure } from '../lib/api'
import { Application, type ApplicationOptions } from '../lib/application'
import { WorkerType } from '../lib/constants'
import { Event } from '../lib/events'
import { BaseExtension } from '../lib/extension'
import { createLogger } from '../lib/logger'
import type { Registry } from '../lib/registry'
import { BaseTaskRunner, Task } from '../lib/tasks'
import { BaseTransport, BaseTransportConnection } from '../lib/transport'

export class TestParser extends BaseParser {
  constructor(private readonly custom?: (schema, val) => any) {
    super()
  }

  parse(schema, val) {
    return this.custom ? this.custom(schema, val) : val
  }
}

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
    super(registry)
  }

  protected sendEvent(eventName: string, payload: any): boolean {
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

export class TestTransport extends BaseTransport<TestConnection<any>> {
  static readonly key = 'test'

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

export const testConnection = <T = {}>(registry: Registry, data?: T) => {
  return new TestConnection(registry, data ?? {})
}

export const testFormat = () => new TestFormat()

export const testProcedure = () => new Procedure().withTransport(TestTransport)

export const testTask = () => new Task()

export const testEvent = () => new Event()

export const testTaskRunner = (...args) => new TestTaskRunner(...args)

export const expectCopy = (source, targer) => {
  expect(targer).not.toBe(source)
  expect(targer).toEqual(source)
}
