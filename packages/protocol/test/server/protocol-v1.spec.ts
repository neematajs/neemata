import { Buffer } from 'node:buffer'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ClientMessageType, ServerMessageType } from '../../src/common/enums.ts'
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

describe('ProtocolVersion1 - decodeMessage', () => {
  let version: ProtocolVersion1
  let context: any

  beforeEach(() => {
    version = new ProtocolVersion1()
    const clientStreams = {
      add: vi.fn(
        (_streamId: number, _metadata: any, _pull: Function) => ({}) as any,
      ),
      get: vi.fn((_streamId: number) => ({}) as any),
    }
    const serverStreams = {
      add: vi.fn((_streamId: number, _blob: any) => ({}) as any),
      get: vi.fn((_streamId: number) => ({}) as any),
    }
    context = {
      connectionId: 'conn',
      streamId: vi.fn(),
      decoder: { decodeRPC: vi.fn() },
      encoder: { encode: vi.fn(), encodeRPC: vi.fn() },
      rpcs: new Map(),
      serverStreams,
      clientStreams,
      transport: { send: vi.fn() },
      container: {},
      protocol: version,
      addClientStream: vi.fn(({ streamId, metadata, pull }) => {
        const stream = (clientStreams.add as any)(streamId, metadata, pull)
        return () => stream
      }),
      addServerStream: vi.fn(({ streamId, blob }) => {
        return (serverStreams.add as any)(streamId, blob)
      }),
    }
  })

  it('decodes RPC payload and wires stream helpers', () => {
    const callId = 33
    const procedure = 'users/list'
    const encoded = Buffer.from([0xde, 0xad])

    let rpcContext: any
    context.decoder.decodeRPC.mockImplementation((buffer, ctx) => {
      rpcContext = ctx
      ctx.addStream(55, { type: 'blob/test' })
      return { ok: Buffer.from(buffer).toString('hex') }
    })
    context.clientStreams.add.mockReturnValue({})

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
    expect(context.decoder.decodeRPC).toHaveBeenCalledTimes(1)
    expect(context.clientStreams.add).toHaveBeenCalledWith(
      55,
      { type: 'blob/test' },
      expect.any(Function),
    )
    const [, , readHandler] = context.clientStreams.add.mock.calls.at(-1)!
    readHandler(1024)
    expect(context.transport.send).toHaveBeenCalledTimes(1)
    const sent = Buffer.from(context.transport.send.mock.calls[0][1])
    expect(sent[0]).toBe(ServerMessageType.ClientStreamPull)
    expect(sent.readUInt32LE(1)).toBe(55)
    expect(sent.readUInt32LE(5)).toBe(1024)
    expect(rpcContext).toMatchObject({ addStream: expect.any(Function) })
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
  let context: any

  beforeEach(() => {
    version = new ProtocolVersion1()
    const streamHandlers: Record<string, Function> = {}
    const streamMock = {
      on: vi.fn((event, handler) => {
        streamHandlers[event] = handler
        return streamMock
      }),
      pause: vi.fn(),
    }

    const clientStreams = { add: vi.fn(), get: vi.fn() }
    const serverStreams = {
      add: vi.fn(() => streamMock),
      get: vi.fn(() => streamMock),
    }

    context = {
      connectionId: 'conn',
      streamId: vi.fn().mockReturnValue(123),
      decoder: { decodeRPC: vi.fn() },
      encoder: { encode: vi.fn(), encodeRPC: vi.fn() },
      rpcs: new Map(),
      serverStreams,
      clientStreams,
      transport: { send: vi.fn() },
      container: {},
      protocol: version,
      __streamHandlers: streamHandlers,
      addClientStream: vi.fn(({ streamId, metadata, pull }) => {
        const stream = (clientStreams.add as any)(streamId, metadata, pull)
        return () => stream
      }),
      addServerStream: vi.fn(({ streamId, blob }) => {
        return (serverStreams.add as any)(streamId, blob)
      }),
    }
  })

  const toBuffer = (view: ArrayBufferView) => Buffer.from(view as Uint8Array)

  it('encodes RPC response success path', () => {
    context.encoder.encodeRPC.mockImplementation((_result, rpcContext) => {
      rpcContext.addStream({ metadata: { type: 'test' }, source: {} } as any)
      return Buffer.from([0xaa])
    })

    const buffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.RpcResponse, {
        callId: 50,
        result: { ok: true },
        error: null,
      }),
    )

    expect(buffer[0]).toBe(ServerMessageType.RpcResponse)
    expect(buffer.readUInt32LE(1)).toBe(50)
    expect(buffer[5]).toBe(0)
    expect(buffer.subarray(6)).toEqual(Buffer.from([0xaa]))
    expect(context.serverStreams.add).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ metadata: { type: 'test' } }),
    )
  })

  it('encodes RPC response error path', () => {
    context.encoder.encode.mockReturnValue(Buffer.from([0xbb]))
    const buffer = toBuffer(
      version.encodeMessage(context, ServerMessageType.RpcResponse, {
        callId: 10,
        result: null,
        error: { message: 'boom' },
      }),
    )
    expect(buffer[5]).toBe(1)
    expect(buffer.subarray(6)).toEqual(Buffer.from([0xbb]))
    expect(context.encoder.encode).toHaveBeenCalled()
  })

  it('sends chunk/end/abort notifications for server streams', () => {
    context.encoder.encodeRPC.mockImplementation((_result, rpcContext) => {
      rpcContext.addStream({ metadata: { type: 'test' }, source: {} } as any)
      return Buffer.from([0x01])
    })
    version.encodeMessage(context, ServerMessageType.RpcResponse, {
      callId: 1,
      result: 'ok',
      error: null,
    })

    const handlers = context.__streamHandlers as Record<string, Function>
    const chunk = Buffer.from('data')
    handlers.data?.(chunk)
    expect(context.transport.send).toHaveBeenCalledTimes(1)
    let sent = Buffer.from(context.transport.send.mock.calls.at(-1)[1])
    expect(sent[0]).toBe(ServerMessageType.ServerStreamPush)
    expect(sent.readUInt32LE(1)).toBe(123)
    expect(sent.subarray(5)).toEqual(chunk)

    handlers.error?.(new Error('fail'))
    sent = Buffer.from(context.transport.send.mock.calls.at(-1)[1])
    expect(sent[0]).toBe(ServerMessageType.ServerStreamAbort)
    expect(sent.readUInt32LE(1)).toBe(123)

    handlers.end?.()
    sent = Buffer.from(context.transport.send.mock.calls.at(-1)[1])
    expect(sent[0]).toBe(ServerMessageType.ServerStreamEnd)
    expect(sent.readUInt32LE(1)).toBe(123)
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
