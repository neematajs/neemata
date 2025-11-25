import { Buffer } from 'node:buffer'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProtocolVersion1 } from '../../src/client/versions/v1.ts'
import { ClientMessageType, ServerMessageType } from '../../src/common/enums.ts'

const encodeUInt32 = (value: number) => {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value, 0)
  return buffer
}

const buildMessage = (type: number, payload: Buffer) =>
  Buffer.concat([Buffer.from([type]), payload])

const toBuffer = (view: ArrayBufferView) => Buffer.from(view as Uint8Array)

describe('ProtocolVersion1 (client) - decodeMessage', () => {
  let version: ProtocolVersion1
  let context: any

  beforeEach(() => {
    version = new ProtocolVersion1()
    context = {
      decoder: { decode: vi.fn(), decodeRPC: vi.fn() },
      encoder: { encode: vi.fn(), encodeRPC: vi.fn() },
      clientStreams: { add: vi.fn(), get: vi.fn() },
      serverStreams: { add: vi.fn((_, stream) => stream), get: vi.fn() },
      transport: { send: vi.fn() },
      streamId: vi.fn().mockReturnValue(1),
    }
  })

  it('decodes RPC success payload and registers blob streams', () => {
    const callId = 5
    const rpcPayload = Buffer.from([0xaa])
    context.serverStreams.get.mockReturnValue({})
    context.decoder.decodeRPC.mockImplementation((_payload, rpcContext) => {
      rpcContext.addStream(42, { type: 'blob/test' })
      rpcContext.getStream(42)
      return { ok: true }
    })

    const buffer = buildMessage(
      ServerMessageType.RpcResponse,
      Buffer.concat([encodeUInt32(callId), Buffer.from([0]), rpcPayload]),
    )

    const message = version.decodeMessage(context, buffer)
    expect(message).toEqual({
      type: ServerMessageType.RpcResponse,
      callId,
      result: { ok: true },
    })
    expect(context.decoder.decodeRPC).toHaveBeenCalledWith(
      rpcPayload,
      expect.objectContaining({ addStream: expect.any(Function) }),
    )
    expect(context.serverStreams.add).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ metadata: { type: 'blob/test' } }),
    )
  })

  it('decodes RPC error payload', () => {
    const callId = 7
    const errorPayload = Buffer.from([0xbb])
    const error = { code: 'ERR', message: 'boom' }
    context.decoder.decode.mockReturnValue(error)

    const buffer = buildMessage(
      ServerMessageType.RpcResponse,
      Buffer.concat([encodeUInt32(callId), Buffer.from([1]), errorPayload]),
    )

    expect(version.decodeMessage(context, buffer)).toEqual({
      type: ServerMessageType.RpcResponse,
      callId,
      error,
    })
    expect(context.decoder.decode).toHaveBeenCalledWith(errorPayload)
  })

  it('decodes RPC stream response with optional error', () => {
    const callId = 11
    const successMessage = buildMessage(
      ServerMessageType.RpcStreamResponse,
      encodeUInt32(callId),
    )
    expect(version.decodeMessage(context, successMessage)).toEqual({
      type: ServerMessageType.RpcStreamResponse,
      callId,
      error: undefined,
    })

    const errorPayload = Buffer.from([0xdd])
    context.decoder.decode.mockReturnValue({ code: 'E', message: 'fail' })
    const errorMessage = buildMessage(
      ServerMessageType.RpcStreamResponse,
      Buffer.concat([encodeUInt32(callId), errorPayload]),
    )
    expect(version.decodeMessage(context, errorMessage)).toEqual({
      type: ServerMessageType.RpcStreamResponse,
      callId,
      error: { code: 'E', message: 'fail' },
    })
  })

  it('decodes stream chunk/end/abort messages', () => {
    const chunk = Buffer.from([1, 2, 3])
    expect(
      version.decodeMessage(
        context,
        buildMessage(
          ServerMessageType.RpcStreamChunk,
          Buffer.concat([encodeUInt32(1), chunk]),
        ),
      ),
    ).toEqual({ type: ServerMessageType.RpcStreamChunk, callId: 1, chunk })

    expect(
      version.decodeMessage(
        context,
        buildMessage(ServerMessageType.RpcStreamEnd, encodeUInt32(2)),
      ),
    ).toEqual({ type: ServerMessageType.RpcStreamEnd, callId: 2 })

    expect(
      version.decodeMessage(
        context,
        buildMessage(ServerMessageType.RpcStreamAbort, encodeUInt32(3)),
      ),
    ).toEqual({ type: ServerMessageType.RpcStreamAbort, callId: 3 })
  })

  it('decodes client/server stream control messages', () => {
    const pullMessage = buildMessage(
      ServerMessageType.ClientStreamPull,
      Buffer.concat([encodeUInt32(9), encodeUInt32(1024)]),
    )
    expect(version.decodeMessage(context, pullMessage)).toEqual({
      type: ServerMessageType.ClientStreamPull,
      streamId: 9,
      size: 1024,
    })

    expect(
      version.decodeMessage(
        context,
        buildMessage(ServerMessageType.ClientStreamAbort, encodeUInt32(10)),
      ),
    ).toEqual({ type: ServerMessageType.ClientStreamAbort, streamId: 10 })

    const pushChunk = Buffer.from('payload')
    expect(
      version.decodeMessage(
        context,
        buildMessage(
          ServerMessageType.ServerStreamPush,
          Buffer.concat([encodeUInt32(20), pushChunk]),
        ),
      ),
    ).toEqual({
      type: ServerMessageType.ServerStreamPush,
      streamId: 20,
      chunk: pushChunk,
    })

    expect(
      version.decodeMessage(
        context,
        buildMessage(ServerMessageType.ServerStreamEnd, encodeUInt32(21)),
      ),
    ).toEqual({ type: ServerMessageType.ServerStreamEnd, streamId: 21 })

    expect(
      version.decodeMessage(
        context,
        buildMessage(ServerMessageType.ServerStreamAbort, encodeUInt32(22)),
      ),
    ).toEqual({ type: ServerMessageType.ServerStreamAbort, streamId: 22 })
  })

  it('throws on unsupported message type', () => {
    const buffer = buildMessage(255, Buffer.alloc(0))
    expect(() => version.decodeMessage(context, buffer)).toThrow(
      /Unsupported message type/,
    )
  })
})

describe('ProtocolVersion1 (client) - encodeMessage', () => {
  let version: ProtocolVersion1
  let context: any

  beforeEach(() => {
    version = new ProtocolVersion1()
    context = {
      decoder: { decode: vi.fn(), decodeRPC: vi.fn() },
      encoder: { encode: vi.fn(), encodeRPC: vi.fn() },
      clientStreams: { add: vi.fn(), get: vi.fn() },
      serverStreams: { add: vi.fn(), get: vi.fn() },
      transport: { send: vi.fn() },
      streamId: vi.fn().mockReturnValue(77),
    }
  })

  it('encodes RPC call payload and registers client streams', () => {
    const blob = {
      metadata: { type: 'blob/test' },
      source: new ReadableStream({ start: (controller) => controller.close() }),
    }
    context.clientStreams.add.mockReturnValue(blob)
    context.clientStreams.get.mockReturnValue(blob)
    context.encoder.encodeRPC.mockImplementation((_payload, rpcContext) => {
      rpcContext.addStream(blob)
      rpcContext.getStream(77)
      return { buffer: Uint8Array.from([0xcc]), streams: {} }
    })

    const buffer = toBuffer(
      version.encodeMessage(context, ClientMessageType.Rpc, {
        callId: 100,
        procedure: 'user.list',
        payload: { take: 10 },
      }),
    )

    const procedureBytes = Buffer.from('user.list')
    expect(buffer[0]).toBe(ClientMessageType.Rpc)
    expect(buffer.readUInt32LE(1)).toBe(100)
    expect(buffer.readUInt16LE(5)).toBe(procedureBytes.length)
    expect(buffer.subarray(7, 7 + procedureBytes.length)).toEqual(
      procedureBytes,
    )
    expect(buffer.subarray(7 + procedureBytes.length)).toEqual(
      Buffer.from([0xcc]),
    )
    expect(context.encoder.encodeRPC).toHaveBeenCalledTimes(1)
    expect(context.clientStreams.add).toHaveBeenCalledWith(
      blob.source,
      77,
      blob.metadata,
    )
  })

  it('encodes RpcAbort', () => {
    const buffer = toBuffer(
      version.encodeMessage(context, ClientMessageType.RpcAbort, {
        callId: 55,
      }),
    )
    expect(buffer[0]).toBe(ClientMessageType.RpcAbort)
    expect(buffer.readUInt32LE(1)).toBe(55)
  })

  it('encodes client stream push/end/abort', () => {
    const pushBuffer = toBuffer(
      version.encodeMessage(context, ClientMessageType.ClientStreamPush, {
        streamId: 5,
        chunk: Buffer.from('hello'),
      }),
    )
    expect(pushBuffer[0]).toBe(ClientMessageType.ClientStreamPush)
    expect(pushBuffer.readUInt32LE(1)).toBe(5)
    expect(pushBuffer.subarray(5).toString()).toBe('hello')

    const endBuffer = toBuffer(
      version.encodeMessage(context, ClientMessageType.ClientStreamEnd, {
        streamId: 6,
      }),
    )
    expect(endBuffer[0]).toBe(ClientMessageType.ClientStreamEnd)
    expect(endBuffer.readUInt32LE(1)).toBe(6)

    const abortBuffer = toBuffer(
      version.encodeMessage(context, ClientMessageType.ClientStreamAbort, {
        streamId: 7,
      }),
    )
    expect(abortBuffer[0]).toBe(ClientMessageType.ClientStreamAbort)
    expect(abortBuffer.readUInt32LE(1)).toBe(7)
  })

  it('encodes server stream control messages', () => {
    const pullBuffer = toBuffer(
      version.encodeMessage(context, ClientMessageType.ServerStreamPull, {
        streamId: 8,
        size: 2048,
      }),
    )
    expect(pullBuffer[0]).toBe(ClientMessageType.ServerStreamPull)
    expect(pullBuffer.readUInt32LE(1)).toBe(8)
    expect(pullBuffer.readUInt32LE(5)).toBe(2048)

    const abortBuffer = toBuffer(
      version.encodeMessage(context, ClientMessageType.ServerStreamAbort, {
        streamId: 9,
      }),
    )
    expect(abortBuffer[0]).toBe(ClientMessageType.ServerStreamAbort)
    expect(abortBuffer.readUInt32LE(1)).toBe(9)
  })

  it('throws on unsupported client message type', () => {
    expect(() =>
      version.encodeMessage(context, 255 as ClientMessageType, {} as any),
    ).toThrow(/Unsupported message type/)
  })
})
