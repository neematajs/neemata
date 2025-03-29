import { randomUUID } from 'node:crypto'
// import type { TAnyEventContract } from '@nmtjs/contract'
import type { InteractivePromise } from '@nmtjs/common'
import type { Container } from '@nmtjs/core'
import type { ProtocolApiCallResult } from './api.ts'
import type { BaseServerDecoder, BaseServerEncoder } from './format.ts'
import type { ProtocolClientStream, ProtocolServerStream } from './stream.ts'

// export type NotifyFn = <T extends TAnyEventContract>(
//   connection: Connection,
//   contract: T,
//   payload: t.infer.input.decoded<T['payload']>,
// ) => Promise<boolean>

// export type ConnectionNotifyFn = (
//   contract: TAnyEventContract,
//   payload: unknown,
// ) => Promise<boolean>

export type ConnectionOptions<Data = unknown> = {
  id?: string
  data: Data
}

export class Connection<Data = unknown> {
  readonly id: string
  readonly data: Data

  constructor(options: ConnectionOptions<Data>) {
    this.id = options.id ?? randomUUID()
    this.data = options.data
  }
}

export type ConnectionCall<T = unknown> = InteractivePromise<T> & {
  abort: AbortController['abort']
}

export class ConnectionContext {
  streamId = 1
  calls = new Map<number, ConnectionCall<ProtocolApiCallResult>>()
  clientStreams = new Map<number, ProtocolClientStream>()
  serverStreams = new Map<number, ProtocolServerStream>()
  container: Container
  format: {
    encoder: BaseServerEncoder
    decoder: BaseServerDecoder
  }

  constructor(
    container: ConnectionContext['container'],
    format: ConnectionContext['format'],
  ) {
    this.container = container
    this.format = format
  }
}
