import { Buffer } from 'node:buffer'

import type { GatewayApi } from '@nmtjs/gateway'
import type { SendResult } from '@nmtjs/protocol/server'
import { Container, createLogger, Hooks } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'
import { ClientMessageType, ProtocolVersion } from '@nmtjs/protocol'
import { BaseServerCodec } from '@nmtjs/protocol/server'
import { vi } from 'vitest'

import type { WsSessionHeartbeatOptions } from '../../../../src/neemata/ws/session.ts'
import { WsSessionEngine } from '../../../../src/neemata/ws/session.ts'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * JSON codec that registers a client (upload) stream when the RPC payload
 * carries a `__stream` marker, mirroring what real codecs do for blobs.
 */
export class StreamTestCodec extends BaseServerCodec {
  accept = ['application/json']
  contentType = 'application/json'

  encode(data: unknown): ArrayBufferView {
    return textEncoder.encode(JSON.stringify(data))
  }

  encodeRPC(data: unknown): ArrayBufferView {
    return this.encode(data ?? null)
  }

  encodeBlob(streamId: number, metadata: unknown) {
    return { streamId, metadata }
  }

  decode(buffer: ArrayBufferView) {
    return JSON.parse(textDecoder.decode(buffer))
  }

  decodeRPC(buffer: ArrayBufferView, context: any) {
    const data = this.decode(buffer)
    if (data && typeof data === 'object' && data.__stream !== undefined) {
      context.addStream(data.__stream, { type: 'application/octet-stream' })
    }
    return data
  }
}

export type SentMessage = { type: number; id: number; rest: Buffer }

export const decodeSent = (buffer: Buffer): SentMessage => ({
  type: buffer.readUInt8(0),
  id: buffer.readUInt32LE(1),
  rest: buffer.subarray(5),
})

export const encodeRpcMessage = (
  callId: number,
  procedure: string,
  payload: any,
) => {
  const name = Buffer.from(procedure, 'utf-8')
  const header = Buffer.alloc(7)
  header.writeUInt8(ClientMessageType.Rpc, 0)
  header.writeUInt32LE(callId, 1)
  header.writeUInt16LE(name.byteLength, 5)
  return Buffer.concat([header, name, Buffer.from(JSON.stringify(payload))])
}

export const encodeRpcAbort = (callId: number) => {
  const buffer = Buffer.alloc(5)
  buffer.writeUInt8(ClientMessageType.RpcAbort, 0)
  buffer.writeUInt32LE(callId, 1)
  return buffer
}

export const encodeRpcStreamPull = (callId: number, size: number) => {
  const buffer = Buffer.alloc(9)
  buffer.writeUInt8(ClientMessageType.RpcStreamPull, 0)
  buffer.writeUInt32LE(callId, 1)
  buffer.writeUInt32LE(size, 5)
  return buffer
}

export const encodeServerBlobPull = (streamId: number, size: number) => {
  const buffer = Buffer.alloc(9)
  buffer.writeUInt8(ClientMessageType.ServerBlobPull, 0)
  buffer.writeUInt32LE(streamId, 1)
  buffer.writeUInt32LE(size, 5)
  return buffer
}

export const encodeClientBlobPush = (streamId: number, chunk: Buffer) => {
  const header = Buffer.alloc(5)
  header.writeUInt8(ClientMessageType.ClientBlobPush, 0)
  header.writeUInt32LE(streamId, 1)
  return Buffer.concat([header, chunk])
}

export const encodePong = (nonce: number) => {
  const buffer = Buffer.alloc(5)
  buffer.writeUInt8(ClientMessageType.Pong, 0)
  buffer.writeUInt32LE(nonce, 1)
  return buffer
}

export const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A real Gateway (application kernel) behind a WsSessionEngine driven
 * directly with wire frames — the moved-machinery equivalent of the old
 * mock-transport gateway harness.
 */
export async function createEngineHarness(options?: {
  call?: GatewayApi['call']
  resolve?: GatewayApi['resolve']
  streamIdleTimeout?: number
  heartbeat?: WsSessionHeartbeatOptions
  sendResult?: (message: SentMessage) => SendResult
  // invoked synchronously inside the engine's send, after recording
  onSend?: (message: SentMessage) => void
}) {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
  const container = new Container({ logger })
  const codec = new StreamTestCodec()

  const api: GatewayApi = {
    resolve: vi.fn(
      options?.resolve ?? (async () => ({ name: 'test', stream: false })),
    ),
    call: vi.fn(options?.call ?? (async () => null)),
  }

  let params: any
  const transport = {
    start: vi.fn(async (_params: any) => {
      params = _params
      return 'test://'
    }),
    stop: vi.fn(async () => {}),
  }

  const gateway = new Gateway({
    logger,
    container,
    hooks: new Hooks(),
    transports: { test: { transport } },
    api,
  })

  await gateway.start()

  const sent: SentMessage[] = []
  const close = vi.fn()

  const engine = new WsSessionEngine(params, {
    streamIdleTimeout: options?.streamIdleTimeout,
    heartbeat: options?.heartbeat ?? false,
    send: (_connectionId, buffer) => {
      const message = decodeSent(Buffer.from(buffer as Uint8Array))
      sent.push(message)
      const result = options?.sendResult?.(message) ?? 'delivered'
      options?.onSend?.(message)
      return result
    },
    terminate: async (connectionId, closeArgs) => {
      close(connectionId, closeArgs)
      engine.close(connectionId)
      await params.onDisconnect(connectionId)
    },
    logger: { warn: () => {}, error: () => {} },
  })

  const connection = await params.onConnect({ data: {} })
  engine.open(connection, {
    protocolVersion: ProtocolVersion.v1,
    encoder: codec,
    decoder: codec,
  })

  const send = (data: Buffer) => engine.receive(connection.id, data)

  const sentOfType = (type: number) => sent.filter((m) => m.type === type)

  // mirrors handler dispose: wire state first, then the gateway connection,
  // then the gateway itself
  const stop = async () => {
    engine.close(connection.id)
    await params.onDisconnect(connection.id)
    await gateway.stop()
  }

  return {
    gateway,
    engine,
    api,
    sent,
    sentOfType,
    connection,
    send,
    close,
    stop,
    getParams: () => params,
  }
}
