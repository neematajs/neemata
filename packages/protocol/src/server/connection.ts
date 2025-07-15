import { randomUUID } from 'node:crypto'
import type { Container } from '@nmtjs/core'
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

export class ConnectionContext {
  streamId = 1
  rpcs = new Map<number, AbortController>()
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
