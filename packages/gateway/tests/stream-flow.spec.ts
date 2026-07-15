import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { Hooks } from '@nmtjs/core'
import {
  ClientMessageType,
  ConnectionType,
  ProtocolVersion,
  ServerMessageType,
} from '@nmtjs/protocol'
import { BaseServerFormat, ProtocolFormats } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import type { GatewayApi } from '../src/api.ts'
import { Gateway } from '../src/gateway.ts'
import * as injectables from '../src/injectables.ts'
import {
  STREAM_CREDIT_VIOLATION_REASON,
  STREAM_IDLE_TIMEOUT_REASON,
  STREAM_TRANSPORT_DROP_REASON,
} from '../src/streams.ts'
import { createTestContainer, createTestLogger } from './_helpers/test-utils.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * JSON format that registers a client (upload) stream when the RPC payload
 * carries a `__stream` marker, mirroring what real formats do for blobs.
 */
class StreamTestFormat extends BaseServerFormat {
  accept = ['application/json']
  contentType = 'application/json'

  encode(data: unknown): ArrayBufferView {
    return encoder.encode(JSON.stringify(data))
  }

  encodeRPC(data: unknown): ArrayBufferView {
    return this.encode(data ?? null)
  }

  encodeBlob(streamId: number, metadata: unknown) {
    return { streamId, metadata }
  }

  decode(buffer: ArrayBufferView) {
    return JSON.parse(decoder.decode(buffer))
  }

  decodeRPC(buffer: ArrayBufferView, context: any) {
    const data = this.decode(buffer)
    if (data && typeof data === 'object' && data.__stream !== undefined) {
      context.addStream(data.__stream, { type: 'application/octet-stream' })
    }
    return data
  }
}

const encodeRpcMessage = (callId: number, procedure: string, payload: any) => {
  const name = Buffer.from(procedure, 'utf-8')
  const header = Buffer.alloc(7)
  header.writeUInt8(ClientMessageType.Rpc, 0)
  header.writeUInt32LE(callId, 1)
  header.writeUInt16LE(name.byteLength, 5)
  return Buffer.concat([header, name, Buffer.from(JSON.stringify(payload))])
}

const encodeRpcAbort = (callId: number) => {
  const buffer = Buffer.alloc(5)
  buffer.writeUInt8(ClientMessageType.RpcAbort, 0)
  buffer.writeUInt32LE(callId, 1)
  return buffer
}

const encodeRpcStreamPull = (callId: number, size: number) => {
  const buffer = Buffer.alloc(9)
  buffer.writeUInt8(ClientMessageType.RpcStreamPull, 0)
  buffer.writeUInt32LE(callId, 1)
  buffer.writeUInt32LE(size, 5)
  return buffer
}

const encodeServerStreamPull = (streamId: number, size: number) => {
  const buffer = Buffer.alloc(9)
  buffer.writeUInt8(ClientMessageType.ServerStreamPull, 0)
  buffer.writeUInt32LE(streamId, 1)
  buffer.writeUInt32LE(size, 5)
  return buffer
}

const encodeClientStreamPush = (streamId: number, chunk: Buffer) => {
  const header = Buffer.alloc(5)
  header.writeUInt8(ClientMessageType.ClientStreamPush, 0)
  header.writeUInt32LE(streamId, 1)
  return Buffer.concat([header, chunk])
}

type SentMessage = { type: number; id: number; rest: Buffer }

const decodeSent = (buffer: Buffer): SentMessage => ({
  type: buffer.readUInt8(0),
  id: buffer.readUInt32LE(1),
  rest: buffer.subarray(5),
})

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function createTestGateway(options?: {
  call?: GatewayApi['call']
  streamIdleTimeout?: number
  sendResult?: (message: SentMessage) => boolean
}) {
  const logger = createTestLogger()
  const container = createTestContainer({ logger })
  const serverFormat = new StreamTestFormat()

  const api: GatewayApi = {
    resolve: vi.fn(async () => ({ name: 'test', stream: false })),
    call: vi.fn(options?.call ?? (async () => null)),
  }

  let params: any
  const sent: SentMessage[] = []

  const transport = {
    start: vi.fn(async (_params) => {
      params = _params
      return 'test://'
    }),
    stop: vi.fn(async () => {}),
    send: vi.fn((_connectionId: string, buffer: ArrayBufferView) => {
      const message = decodeSent(Buffer.from(buffer as Uint8Array))
      sent.push(message)
      return options?.sendResult?.(message) ?? true
    }),
    close: vi.fn((_connectionId: string) => {}),
  }

  const gateway = new Gateway({
    logger,
    container,
    hooks: new Hooks(),
    formats: new ProtocolFormats([serverFormat]),
    transports: { test: { transport } },
    api,
    heartbeat: false,
    streamIdleTimeout: options?.streamIdleTimeout,
  })

  await gateway.start()

  const connection = await params.onConnect({
    type: ConnectionType.Bidirectional,
    protocolVersion: ProtocolVersion.v1,
    accept: serverFormat.contentType,
    contentType: serverFormat.contentType,
    data: {},
  })

  const send = (data: Buffer) =>
    params.onMessage({ connectionId: connection.id, data })

  const sentOfType = (type: number) => sent.filter((m) => m.type === type)

  return { gateway, api, sent, sentOfType, connection, send }
}

describe('RPC stream flow control', () => {
  it('gates chunks on RpcStreamPull credits', async () => {
    let finished = false
    async function* handler() {
      try {
        yield 'a'
        yield 'b'
        yield 'c'
      } finally {
        finished = true
      }
    }

    const { gateway, sentOfType, send } = await createTestGateway({
      call: async () => () => handler(),
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()

    expect(sentOfType(ServerMessageType.RpcStreamResponse).length).toBe(1)
    // no credit yet: no chunk may be sent
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(0)

    await send(encodeRpcStreamPull(1, 1))
    await flush()
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(1)
    expect(
      JSON.parse(sentOfType(ServerMessageType.RpcStreamChunk)[0].rest as any),
    ).toBe('a')

    await send(encodeRpcStreamPull(1, 2))
    await flush()
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(3)
    expect(sentOfType(ServerMessageType.RpcStreamEnd).length).toBe(1)
    expect(finished).toBe(true)

    await inFlight
    await gateway.stop()
  })

  it('runs the handler cleanup when the client aborts mid-stream', async () => {
    let finished = false
    async function* handler() {
      try {
        while (true) yield 'tick'
      } finally {
        finished = true
      }
    }

    const { gateway, sentOfType, send } = await createTestGateway({
      call: async () => () => handler(),
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()
    await send(encodeRpcStreamPull(1, 1))
    await flush()
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(1)

    await send(encodeRpcAbort(1))
    await inFlight

    expect(finished).toBe(true)
    expect(sentOfType(ServerMessageType.RpcStreamAbort).length).toBe(1)
    expect(gateway.rpcs.get('any', 1)).toBeUndefined()

    await gateway.stop()
  })

  it('runs the handler cleanup on connection teardown', async () => {
    let finished = false
    async function* handler() {
      try {
        while (true) yield 'tick'
      } finally {
        finished = true
      }
    }

    const { gateway, send } = await createTestGateway({
      call: async () => () => handler(),
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()

    // handler is parked waiting for credit; teardown must release it
    await gateway.stop()
    await inFlight

    expect(finished).toBe(true)
  })

  it('aborts the stream when a chunk frame is dropped by the transport', async () => {
    let finished = false
    async function* handler() {
      try {
        while (true) yield 'tick'
      } finally {
        finished = true
      }
    }

    const { gateway, sentOfType, send } = await createTestGateway({
      call: async () => () => handler(),
      sendResult: (message) =>
        message.type !== ServerMessageType.RpcStreamChunk,
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()
    await send(encodeRpcStreamPull(1, 10))
    await inFlight

    expect(finished).toBe(true)
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(1)
    const aborts = sentOfType(ServerMessageType.RpcStreamAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].rest.toString()).toBe(STREAM_TRANSPORT_DROP_REASON)

    await gateway.stop()
  })

  it('reaps a stream whose consumer never pulls via the idle timeout', async () => {
    let finished = false
    async function* handler() {
      try {
        while (true) yield 'tick'
      } finally {
        finished = true
      }
    }

    const { gateway, sentOfType, send } = await createTestGateway({
      call: async () => () => handler(),
      streamIdleTimeout: 50,
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await inFlight

    expect(finished).toBe(true)
    const aborts = sentOfType(ServerMessageType.RpcStreamAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].rest.toString()).toBe(STREAM_IDLE_TIMEOUT_REASON)

    await gateway.stop()
  })
})

describe('Upload stream flow control', () => {
  it('aborts an upload stream on a push exceeding granted credit', async () => {
    // hold the call in flight so its streams stay alive
    let release!: () => void
    const pending = new Promise<null>((resolve) => {
      release = () => resolve(null)
    })

    const { gateway, sentOfType, send } = await createTestGateway({
      call: async () => pending,
    })

    const inFlight = send(encodeRpcMessage(1, 'test', { __stream: 7 }))
    await flush()

    // no ClientStreamPull was ever sent: any push violates the credit
    await send(encodeClientStreamPush(7, Buffer.from('overflow')))

    const aborts = sentOfType(ServerMessageType.ClientStreamAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].id).toBe(7)
    expect(aborts[0].rest.toString()).toBe(STREAM_CREDIT_VIOLATION_REASON)
    expect(gateway.blobStreams.clientStreams.size).toBe(0)

    release()
    await inFlight
    await gateway.stop()
  })
})

describe('Download stream flow control', () => {
  it('sends pushes only against granted byte credits', async () => {
    const { gateway, sentOfType, send } = await createTestGateway({
      call: async ({ container }) => {
        const createBlob = await container.resolve(injectables.createBlob)
        createBlob(Readable.from([Buffer.alloc(100, 0xcd)]), {
          type: 'application/octet-stream',
          size: 100,
        })
        return { ok: true }
      },
    })

    await send(encodeRpcMessage(1, 'test', {}))
    await flush()

    expect(sentOfType(ServerMessageType.RpcResponse).length).toBe(1)
    // slow consumer: nothing in flight until the client grants credit
    expect(sentOfType(ServerMessageType.ServerStreamPush).length).toBe(0)

    await send(encodeServerStreamPull(0, 10))
    await flush()

    let pushes = sentOfType(ServerMessageType.ServerStreamPush)
    expect(pushes.length).toBe(1)
    expect(pushes[0].rest.byteLength).toBe(10)

    await send(encodeServerStreamPull(0, 90))
    await flush()

    pushes = sentOfType(ServerMessageType.ServerStreamPush)
    expect(Buffer.concat(pushes.map((p) => p.rest)).byteLength).toBe(100)
    expect(sentOfType(ServerMessageType.ServerStreamEnd).length).toBe(1)
    expect(gateway.blobStreams.serverStreams.size).toBe(0)

    await gateway.stop()
  })
})
