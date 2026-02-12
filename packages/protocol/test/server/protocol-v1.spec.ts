import { Buffer } from 'node:buffer'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MessageContext } from '../../src/server/types.ts'
import { kBlobKey } from '../../src/common/constants.ts'
import { ClientMessageType, ServerMessageType } from '../../src/common/enums.ts'
import { ProtocolClientStream } from '../../src/server/stream.ts'
import { ProtocolVersion1 } from '../../src/server/versions/v1.ts'

const encodeUInt32 = (value: number) => {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value, 0)
  return buffer
}

const encodeUInt16 = (value: number) => {
  const buffer = Buffer.allocUnsafe(2)
  buffer.writeUInt16LE(value, 0)
  return buffer
}

function createMockServerContext(version: ProtocolVersion1): MessageContext {
  return {
    connectionId: 'conn',
    streamId: vi.fn().mockReturnValue(1),
    decoder: { decode: vi.fn(), decodeRPC: vi.fn(), accept: ['test'] },
    encoder: {
      encode: vi.fn(),
      encodeRPC: vi.fn(),
      encodeBlob: vi.fn((streamId, metadata) => ({ streamId, metadata })),
      contentType: 'test',
    },
    protocol: version,
    addClientStream: vi.fn(({ streamId, callId, metadata }) => {
      const consumer = Object.assign(
        () => new ProtocolClientStream(streamId, metadata),
        { metadata, [kBlobKey]: true },
      )
      return consumer
    }),
    transport: { send: vi.fn() },
  }
}

describe('ProtocolVersion1 - decodeMessage', () => {
  let version: ProtocolVersion1
  let context: MessageContext

  beforeEach(() => {
    version = new ProtocolVersion1()
    context = createMockServerContext(version)
  })

  it('decodes RPC payload and wires stream helpers', () => {
    const callId = 33
    const procedure = 'users/list'
    const encoded = Buffer.from([0xde, 0xad])

    const decoder = context.decoder as unknown as {
      decodeRPC: ReturnType<typeof vi.fn>
    }
    let rpcContext: { addStream: (streamId: number, metadata: any) => any }
    decoder.decodeRPC.mockImplementation((buffer, ctx) => {
      rpcContext = ctx
      ctx.addStream(55, { type: 'blob/test' })
      return { ok: Buffer.from(buffer).toString('hex') }
    })

    const payload = Buffer.concat([
      encodeUInt32(callId),
      encodeUInt16(Buffer.byteLength(procedure)),
      Buffer.from(procedure),
      encoded,
    ])
    const message = version.decodeMessage(
      context,
      Buffer.concat([Buffer.from([ClientMessageType.Rpc]), payload]),
    )

    expect(message).toEqual({
      type: ClientMessageType.Rpc,
      rpc: { callId, procedure, payload: { ok: 'dead' } },
    })
    expect(decoder.decodeRPC).toHaveBeenCalledTimes(1)
    expect(context.addClientStream).toHaveBeenCalledWith({
      callId,
      streamId: 55,
      metadata: { type: 'blob/test' },
    })
    expect(rpcContext!).toMatchObject({ addStream: expect.any(Function) })
  })

  it('decodes RpcAbort payload', () => {
    const callId = 99
    const buffer = Buffer.concat([
      Buffer.from([ClientMessageType.RpcAbort]),
      encodeUInt32(callId),
    ])
    expect(version.decodeMessage(context, buffer)).toEqual({
      type: ClientMessageType.RpcAbort,
      callId,
    })
  })

  it('decodes Ping payload', () => {
    const nonce = 123456
    const buffer = Buffer.concat([
      Buffer.from([ClientMessageType.Ping]),
      encodeUInt32(nonce),
    ])
    expect(version.decodeMessage(context, buffer)).toEqual({
      type: ClientMessageType.Ping,
      nonce,
    })
  })

  it('decodes Pong payload', () => {
    const nonce = 7
    const buffer = Buffer.concat([
      Buffer.from([ClientMessageType.Pong]),
      encodeUInt32(nonce),
    ])
    expect(version.decodeMessage(context, buffer)).toEqual({
      type: ClientMessageType.Pong,
      nonce,
    })
  })

  it('decodes ClientStream messages', () => {
    const streamId = 12
    const chunk = Buffer.from('hello')

    const pushBuffer = Buffer.concat([
      Buffer.from([ClientMessageType.ClientStreamPush]),
      encodeUInt32(streamId),
      chunk,
    ])
    expect(version.decodeMessage(context, pushBuffer)).toEqual({
      type: ClientMessageType.ClientStreamPush,
      streamId,
      chunk,
    })

    const endBuffer = Buffer.concat([
      Buffer.from([ClientMessageType.ClientStreamEnd]),
      encodeUInt32(streamId),
    ])
    expect(version.decodeMessage(context, endBuffer)).toEqual({
      type: ClientMessageType.ClientStreamEnd,
      streamId,
    })

    const abortBuffer = Buffer.concat([
      Buffer.from([ClientMessageType.ClientStreamAbort]),
      encodeUInt32(streamId),
    ])
    expect(version.decodeMessage(context, abortBuffer)).toEqual({
      type: ClientMessageType.ClientStreamAbort,
      streamId,
      reason: undefined,
    })
  })

  it('decodes ServerStream control messages', () => {
    const streamId = 77
    const size = 2048

    const pullBuffer = Buffer.concat([
      Buffer.from([ClientMessageType.ServerStreamPull]),
      encodeUInt32(streamId),
      encodeUInt32(size),
    ])
    expect(version.decodeMessage(context, pullBuffer)).toEqual({
      type: ClientMessageType.ServerStreamPull,
      streamId,
      size,
    })

    const abortBuffer = Buffer.concat([
      Buffer.from([ClientMessageType.ServerStreamAbort]),
      encodeUInt32(streamId),
    ])
    expect(version.decodeMessage(context, abortBuffer)).toEqual({
      type: ClientMessageType.ServerStreamAbort,
      streamId,
      reason: undefined,
    })
  })

  it('throws on unsupported message type', () => {
    const buffer = Buffer.from([255])
    expect(() => version.decodeMessage(context, buffer)).toThrow(
      /Unsupported message type/,
    )
  })
})

describe('ProtocolVersion1 - encodeMessage', () => {
  let version: ProtocolVersion1
  let context: MessageContext

  beforeEach(() => {
    version = new ProtocolVersion1()
    context = createMockServerContext(version)
    ;(context.streamId as ReturnType<typeof vi.fn>).mockReturnValue(123)
  })

  const toBuffer = (view: ArrayBufferView) => Buffer.from(view as Uint8Array)

  it('encodes RPC response success path', () => {
    const streams = { 0: { type: 'test', size: 50 } }
    const encoder = context.encoder as unknown as {
      encodeRPC: ReturnType<typeof vi.fn>
    }
    encoder.encodeRPC.mockReturnValue(Buffer.from([0xaa]))

    const buffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.RpcResponse, {
        callId: 50,
        result: { ok: true },
        streams,
        error: null,
      }),
    )

    expect(buffer[0]).toBe(ServerMessageType.RpcResponse)
    expect(buffer.readUInt32LE(1)).toBe(50)
    expect(buffer[5]).toBe(0)
    expect(buffer.subarray(6)).toEqual(Buffer.from([0xaa]))
    expect(encoder.encodeRPC).toHaveBeenCalledWith({ ok: true }, streams)
  })

  it('encodes RPC response error path', () => {
    const encoder = context.encoder as unknown as {
      encode: ReturnType<typeof vi.fn>
    }
    encoder.encode.mockReturnValue(Buffer.from([0xbb]))
    const buffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.RpcResponse, {
        callId: 10,
        result: null,
        error: { message: 'boom' },
        streams: {},
      }),
    )
    expect(buffer[5]).toBe(1)
    expect(buffer.subarray(6)).toEqual(Buffer.from([0xbb]))
    expect(encoder.encode).toHaveBeenCalled()
  })

  it('encodes Pong payload', () => {
    const buffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.Pong, { nonce: 42 }),
    )
    expect(buffer[0]).toBe(ServerMessageType.Pong)
    expect(buffer.readUInt32LE(1)).toBe(42)
  })

  it('encodes Ping payload', () => {
    const buffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.Ping, { nonce: 99 }),
    )
    expect(buffer[0]).toBe(ServerMessageType.Ping)
    expect(buffer.readUInt32LE(1)).toBe(99)
  })

  it('encodes RPC response with streams metadata', () => {
    const streams = {
      0: { type: 'test' },
      1: { type: 'image/png', size: 1024 },
    }
    const encoder = context.encoder as unknown as {
      encodeRPC: ReturnType<typeof vi.fn>
    }
    encoder.encodeRPC.mockReturnValue(Buffer.from([0x01]))

    const buffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.RpcResponse, {
        callId: 1,
        result: 'ok',
        streams,
        error: null,
      }),
    )

    expect(buffer[0]).toBe(ServerMessageType.RpcResponse)
    expect(encoder.encodeRPC).toHaveBeenCalledWith('ok', streams)
  })

  it('encodes RPC stream helpers', () => {
    const responseBuffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.RpcStreamResponse, {
        callId: 9,
      }),
    )
    expect(responseBuffer[0]).toBe(ServerMessageType.RpcStreamResponse)
    expect(responseBuffer.readUInt32LE(1)).toBe(9)

    const chunk = Buffer.from([1, 2, 3])
    const chunkBuffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.RpcStreamChunk, {
        callId: 9,
        chunk,
      }),
    )
    expect(chunkBuffer.subarray(5)).toEqual(chunk)

    const endBuffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.RpcStreamEnd, {
        callId: 9,
      }),
    )
    expect(endBuffer.readUInt32LE(1)).toBe(9)

    const abortBuffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.RpcStreamAbort, {
        callId: 9,
      }),
    )
    expect(abortBuffer.readUInt32LE(1)).toBe(9)
  })

  it('encodes client/server stream control messages', () => {
    const pullBuffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.ClientStreamPull, {
        streamId: 55,
        size: 4096,
      }),
    )
    expect(pullBuffer[0]).toBe(ServerMessageType.ClientStreamPull)
    expect(pullBuffer.readUInt32LE(1)).toBe(55)
    expect(pullBuffer.readUInt32LE(5)).toBe(4096)

    const clientAbort = toBuffer(
      version.encodeMessage(context, ServerMessageType.ClientStreamAbort, {
        streamId: 55,
      }),
    )
    expect(clientAbort[0]).toBe(ServerMessageType.ClientStreamAbort)

    const pushBuffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.ServerStreamPush, {
        streamId: 77,
        chunk: Buffer.from([0x01]),
      }),
    )
    expect(pushBuffer.subarray(5)).toEqual(Buffer.from([0x01]))

    const endBuffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.ServerStreamEnd, {
        streamId: 77,
      }),
    )
    expect(endBuffer.readUInt32LE(1)).toBe(77)

    const abortBuffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.ServerStreamAbort, {
        streamId: 77,
      }),
    )
    expect(abortBuffer.readUInt32LE(1)).toBe(77)
  })

  it('throws on unknown server message type', () => {
    expect(() =>
      version.encodeMessage(context, 255 as ServerMessageType, {} as any),
    ).toThrow(/Unsupported message type/)
  })
})
