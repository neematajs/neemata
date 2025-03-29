import { randomUUID } from 'node:crypto'
import type { InteractivePromise } from '@nmtjs/common'
import type { Container } from '@nmtjs/core'
import type { ProtocolApiCallResult } from './api.ts'
import type { BaseServerDecoder, BaseServerEncoder } from './format.ts'
import type { ProtocolClientStream, ProtocolServerStream } from './stream.ts'

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
  rpcStreams = new Map<number, AbortController>()
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
