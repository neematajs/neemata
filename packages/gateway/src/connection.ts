import type Stream from 'node:stream'

import type { Container } from '@nmtjs/core'
import type {
  ConnectionType,
  ProtocolBlob,
  ProtocolBlobMetadata,
} from '@nmtjs/protocol'
import type {
  BaseServerDecoder,
  BaseServerEncoder,
  ProtocolVersionInterface,
} from '@nmtjs/protocol/server'
import { MAX_UINT32, noopFn, throwError } from '@nmtjs/common'
import {
  ProtocolClientStream,
  ProtocolServerStream,
} from '@nmtjs/protocol/server'

import { StreamTimeout } from './enums.ts'

type ClientStreamRecord = { callId: number; stream: ProtocolClientStream }

export class GatewayConnectionClientStreams {
  private readonly streams = new Map<number, ClientStreamRecord>()
  private readonly calls = new Map<number, Set<number>>()

  get(streamId: number) {
    const record = this.streams.get(streamId) ?? throwError('Stream not found')
    return record.stream
  }

  add(
    callId: number,
    streamId: number,
    metadata: ProtocolBlobMetadata,
    options: Stream.ReadableOptions,
  ) {
    const stream = new ProtocolClientStream(streamId, metadata, options)
    // attach noop error handler to avoid unhandled exception
    stream.on('error', noopFn)
    this.streams.set(streamId, { callId, stream })
    this.track(callId, streamId)
    return stream
  }

  push(streamId: number, chunk: ArrayBufferView) {
    const stream = this.get(streamId)
    stream.write(chunk)
  }

  end(streamId: number) {
    console.trace('Ending client stream', { streamId })
    const stream = this.get(streamId)
    stream.end(null)
    this.remove(streamId)
  }

  abort(streamId: number, error = 'Aborted') {
    console.trace('Aborting client stream', { streamId, error })
    const stream = this.get(streamId)
    stream.destroy(new Error(error))
    this.remove(streamId)
  }

  remove(streamId: number) {
    const record = this.streams.get(streamId) ?? throwError('Stream not found')
    this.streams.delete(streamId)
    this.untrack(record.callId, streamId)
  }

  close(reason = 'Closed') {
    for (const streamId of this.streams.keys()) {
      this.abort(streamId, reason)
    }
    this.streams.clear()
    this.calls.clear()
  }

  *findByCall(callId: number) {
    const streams = this.calls.get(callId)
    if (streams) yield* streams
  }

  consume(callId: number, streamId: number) {
    this.untrack(callId, streamId)
  }

  private track(callId: number, streamId: number) {
    let streams = this.calls.get(callId)
    if (!streams) {
      streams = new Set<number>()
      this.calls.set(callId, streams)
    }
    streams.add(streamId)
  }

  private untrack(callId: number, streamId: number) {
    const streams = this.calls.get(callId)
    if (streams) {
      streams.delete(streamId)
      if (streams.size === 0) {
        this.calls.delete(callId)
      }
    }
  }
}

type ServerStreamRecord = { callId: number; stream: ProtocolServerStream }

export class GatewayConnectionServerStreams {
  protected pullTimeouts = new Map<number, any>()
  protected consumeTimeouts = new Map<number, any>()
  protected finishTimeouts = new Map<number, any>()
  protected timeoutsMap: Record<StreamTimeout, Map<number, any>> = {
    [StreamTimeout.Pull]: this.pullTimeouts,
    [StreamTimeout.Consume]: this.consumeTimeouts,
    [StreamTimeout.Finish]: this.finishTimeouts,
  }
  protected timeoutDuration: Record<StreamTimeout, number>

  private readonly streams = new Map<number, ServerStreamRecord>()
  private readonly calls = new Map<number, Set<number>>()

  constructor(
    protected readonly timeouts: {
      [StreamTimeout.Pull]?: number
      [StreamTimeout.Consume]?: number
      [StreamTimeout.Finish]?: number
    } = {},
  ) {
    this.timeoutDuration = {
      [StreamTimeout.Pull]: 5000,
      [StreamTimeout.Consume]: 5000,
      [StreamTimeout.Finish]: 10000,
      ...timeouts,
    }
  }

  get(streamId: number) {
    const record = this.streams.get(streamId) ?? throwError('Stream not found')
    return record.stream
  }

  add(callId: number, streamId: number, blob: ProtocolBlob) {
    console.debug('Adding server stream', { callId, streamId, blob })
    const stream = new ProtocolServerStream(streamId, blob)
    this.streams.set(streamId, { callId, stream })
    this.track(callId, streamId)
    this.startTimeout(streamId, StreamTimeout.Finish)
    this.startTimeout(streamId, StreamTimeout.Consume)
    stream.once('finish', () => {
      this.remove(streamId)
    })
    return stream
  }

  remove(streamId: number) {
    console.debug('Removing server stream', { streamId })
    const record = this.streams.get(streamId) ?? throwError('Stream not found')
    this.streams.delete(streamId)
    this.clearTimeout(streamId, StreamTimeout.Pull)
    this.clearTimeout(streamId, StreamTimeout.Consume)
    this.clearTimeout(streamId, StreamTimeout.Finish)
    this.untrack(record.callId, streamId)
  }

  pull(streamId: number) {
    console.debug('Pulling server stream', { streamId })
    const stream = this.get(streamId)
    stream.resume()
    this.clearTimeout(streamId, StreamTimeout.Consume)
    this.startTimeout(streamId, StreamTimeout.Pull)
  }

  abort(streamId: number, error = 'Aborted') {
    console.debug('Aborting server stream', { streamId, error })
    const stream = this.get(streamId)
    if (stream.listenerCount('error') === 0) stream.on('error', noopFn)
    stream.destroy(new Error(error))
    this.remove(streamId)
  }

  *findByCall(callId: number) {
    const streams = this.calls.get(callId)
    if (!streams) return
    yield* streams
  }

  close(reason = 'Closed') {
    console.debug('Closing server streams', { reason })
    for (const streamId of this.streams.keys()) {
      this.abort(streamId, reason)
    }
    this.streams.clear()
    this.calls.clear()
  }

  protected startTimeout(streamId: number, type: StreamTimeout) {
    console.debug('Starting server stream timeout', { streamId, type })
    const timeoutMap = this.timeoutsMap[type]
    const timeoutDuration = this.timeoutDuration[type]
    this.clearTimeout(streamId, type)
    const timeout = setTimeout(() => {
      this.abort(streamId, `${type} timeout`)
      timeoutMap.delete(streamId)
    }, timeoutDuration)
    timeoutMap.set(streamId, timeout)
  }

  protected clearTimeout(streamId: number, type: StreamTimeout) {
    const timeoutMap = this.timeoutsMap[type]
    const existingTimeout = timeoutMap.get(streamId)
    if (existingTimeout) {
      console.debug('Clearing server stream timeout', { streamId, type })
      clearTimeout(existingTimeout)
      timeoutMap.delete(streamId)
    }
  }

  protected track(callId: number, streamId: number) {
    console.debug('Tracking server stream', { callId, streamId })
    let streams = this.calls.get(callId)
    if (!streams) {
      streams = new Set<number>()
      this.calls.set(callId, streams)
    }
    streams.add(streamId)
  }

  protected untrack(callId: number, streamId: number) {
    console.debug('Untracking server stream', { callId, streamId })
    const streams = this.calls.get(callId)
    if (streams) {
      streams.delete(streamId)
      if (streams.size === 0) {
        this.calls.delete(callId)
      }
    }
  }
}

export class GatewayConnectionRpcs {
  private readonly rpcs = new Map<number, AbortController>()

  get(callId: number) {
    return this.rpcs.get(callId)
  }

  set(callId: number, controller: AbortController) {
    this.rpcs.set(callId, controller)
  }

  remove(callId: number) {
    this.rpcs.delete(callId)
  }

  close(reason = 'Closed') {
    for (const controller of this.rpcs.values()) {
      controller.abort(new Error(reason))
    }
    this.rpcs.clear()
  }
}

export class GatewayConnection {
  readonly id: string
  readonly type: ConnectionType
  readonly transport: string
  readonly protocol: ProtocolVersionInterface
  readonly identity: string
  readonly container: Container
  readonly encoder: BaseServerEncoder
  readonly decoder: BaseServerDecoder

  readonly rpcs = new GatewayConnectionRpcs()
  readonly clientStreams: GatewayConnectionClientStreams
  readonly serverStreams: GatewayConnectionServerStreams

  #streamId = 1

  constructor(options: {
    id: string
    type: ConnectionType
    transport: string
    protocol: ProtocolVersionInterface
    identity: string
    container: Container
    encoder: BaseServerEncoder
    decoder: BaseServerDecoder
    clientStreams: GatewayConnectionClientStreams
    serverStreams: GatewayConnectionServerStreams
  }) {
    this.id = options.id
    this.type = options.type
    this.transport = options.transport
    this.protocol = options.protocol
    this.identity = options.identity
    this.container = options.container
    this.encoder = options.encoder
    this.decoder = options.decoder
    this.clientStreams = options.clientStreams
    this.serverStreams = options.serverStreams
  }

  readonly getStreamId = () => {
    if (this.#streamId >= MAX_UINT32) {
      this.#streamId = 1
    }
    return this.#streamId++
  }
}
