import type { BaseClientFormat } from '@nmtjs/protocol/client'
import {
  ClientMessageType,
  ConnectionType,
  ServerMessageType,
} from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { EventEmitter } from '../src/events.ts'
import { createRpcLayer } from '../src/layers/rpc.ts'
import { BaseClientTransformer } from '../src/transformers.ts'

const encodeJson = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))

// the client package targets browsers, so Node's `process` global is untyped
const nodeProcess = (globalThis as any).process as {
  on: (event: 'unhandledRejection', cb: (reason: unknown) => void) => void
  off: (event: 'unhandledRejection', cb: (reason: unknown) => void) => void
}

class MockCore extends EventEmitter<{
  message: [message: unknown, raw: ArrayBufferView]
  connected: []
  disconnected: [reason: string]
  state_changed: [state: string, previous: string]
  pong: [nonce: number]
}> {
  readonly transportType = ConnectionType.Bidirectional
  readonly state = 'connected'
  readonly application = undefined
  readonly auth = undefined
  readonly connectionSignal = undefined
  readonly messageContext = {} as any

  readonly format: BaseClientFormat = {
    contentType: 'application/json',
    encode: vi.fn(encodeJson),
    decode: vi.fn((chunk) => JSON.parse(new TextDecoder().decode(chunk))),
    encodeRPC: vi.fn(encodeJson),
    decodeRPC: vi.fn((chunk) => JSON.parse(new TextDecoder().decode(chunk))),
  } as BaseClientFormat

  readonly protocol = {
    encodeMessage: vi.fn((_context, type) => new Uint8Array([type])),
  } as any

  readonly send = vi.fn(async () => {})
  readonly transportCall = vi.fn()
  readonly emitClientEvent = vi.fn()
  readonly emitStreamEvent = vi.fn()
}

describe('RPC streams', () => {
  it('sends exactly one RpcStreamPull per consumed chunk and nothing else', async () => {
    const core = new MockCore()
    const rpcLayer = createRpcLayer(
      core as any,
      { addServerBlobStream: vi.fn() } as any,
      new BaseClientTransformer(),
    )

    const streamPromise = rpcLayer.call(
      'users/profile',
      { userId: '1' },
      { _stream_response: true },
    )

    expect(core.send).toHaveBeenCalledTimes(1)

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamResponse, callId: 0 },
      new Uint8Array([1]),
    )

    const iterable = await streamPromise
    core.send.mockClear()
    core.protocol.encodeMessage.mockClear()

    // no credit is granted before the consumer starts iterating
    expect(core.send).not.toHaveBeenCalled()

    const iterator = iterable[Symbol.asyncIterator]()
    const firstChunkPromise = iterator.next()

    await Promise.resolve()
    // the read triggers one single-chunk credit grant
    expect(core.send).toHaveBeenCalledTimes(1)
    expect(core.protocol.encodeMessage).toHaveBeenCalledWith(
      expect.anything(),
      ClientMessageType.RpcStreamPull,
      { callId: 0, size: 1 },
    )

    core.emit(
      'message',
      {
        type: ServerMessageType.RpcStreamChunk,
        callId: 0,
        chunk: encodeJson({ ok: true, echoed: { userId: '1' } }),
      },
      new Uint8Array([2]),
    )

    await expect(firstChunkPromise).resolves.toEqual({
      done: false,
      value: { ok: true, echoed: { userId: '1' } },
    })
    // receiving the chunk itself grants nothing
    expect(core.send).toHaveBeenCalledTimes(1)

    const secondChunkPromise = iterator.next()
    await Promise.resolve()
    expect(core.send).toHaveBeenCalledTimes(2)
    expect(core.protocol.encodeMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      ClientMessageType.RpcStreamPull,
      { callId: 0, size: 1 },
    )

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamEnd, callId: 0 },
      new Uint8Array([3]),
    )

    await expect(secondChunkPromise).resolves.toEqual({
      done: true,
      value: undefined,
    })
    expect(core.send).toHaveBeenCalledTimes(2)
  })

  it('reuses the initial stream when autoReconnect is enabled', async () => {
    const core = new MockCore()
    const rpcLayer = createRpcLayer(
      core as any,
      { addServerBlobStream: vi.fn() } as any,
      new BaseClientTransformer(),
    )

    const streamPromise = rpcLayer.call(
      'users/profile',
      { userId: '1' },
      { _stream_response: true, autoReconnect: true },
    )

    expect(core.send).toHaveBeenCalledTimes(1)

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamResponse, callId: 0 },
      new Uint8Array([1]),
    )

    const iterable = await streamPromise
    core.send.mockClear()

    const iterator = iterable[Symbol.asyncIterator]()
    const firstChunkPromise = iterator.next()

    await Promise.resolve()
    // only the credit grant for the pending read goes out
    expect(core.send).toHaveBeenCalledTimes(1)
    expect(core.protocol.encodeMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      ClientMessageType.RpcStreamPull,
      { callId: 0, size: 1 },
    )

    core.emit(
      'message',
      {
        type: ServerMessageType.RpcStreamChunk,
        callId: 0,
        chunk: encodeJson({ ok: true, echoed: { userId: '1' } }),
      },
      new Uint8Array([2]),
    )

    await expect(firstChunkPromise).resolves.toEqual({
      done: false,
      value: { ok: true, echoed: { userId: '1' } },
    })

    const secondChunkPromise = iterator.next()

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamEnd, callId: 0 },
      new Uint8Array([3]),
    )

    await expect(secondChunkPromise).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it('aborts the stream on a malformed chunk without unhandled rejections', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    nodeProcess.on('unhandledRejection', onUnhandled)

    try {
      const core = new MockCore()
      const rpcLayer = createRpcLayer(
        core as any,
        { addServerBlobStream: vi.fn() } as any,
        new BaseClientTransformer(),
      )

      const streamPromise = rpcLayer.call(
        'users/profile',
        { userId: '1' },
        { _stream_response: true },
      )

      core.emit(
        'message',
        { type: ServerMessageType.RpcStreamResponse, callId: 0 },
        new Uint8Array([1]),
      )

      const iterable = await streamPromise
      const iterator = iterable[Symbol.asyncIterator]()
      const nextPromise = iterator.next()

      core.protocol.encodeMessage.mockClear()

      // invalid JSON: the stream transform (format.decode) throws
      core.emit(
        'message',
        {
          type: ServerMessageType.RpcStreamChunk,
          callId: 0,
          chunk: new TextEncoder().encode('{not json'),
        },
        new Uint8Array([2]),
      )

      // the decode error surfaces to the consumer...
      await expect(nextPromise).rejects.toThrow()

      // ...and the server is told to abort the call
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(core.protocol.encodeMessage).toHaveBeenCalledWith(
        expect.anything(),
        ClientMessageType.RpcAbort,
        expect.objectContaining({ callId: 0 }),
      )

      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      nodeProcess.off('unhandledRejection', onUnhandled)
    }
  })

  it('rejects a pending call when the stream aborts before the stream response', async () => {
    const core = new MockCore()
    const rpcLayer = createRpcLayer(
      core as any,
      { addServerBlobStream: vi.fn() } as any,
      new BaseClientTransformer(),
    )

    const streamPromise = rpcLayer.call(
      'users/profile',
      { userId: '1' },
      { _stream_response: true },
    )

    // abort lands while the call is still pending (e.g. server-side idle
    // timeout before the RpcStreamResponse was ever processed): the call
    // must settle instead of hanging forever
    core.emit(
      'message',
      {
        type: ServerMessageType.RpcStreamAbort,
        callId: 0,
        reason: 'stream idle timeout',
      },
      new Uint8Array([1]),
    )

    await expect(streamPromise).rejects.toThrow('stream idle timeout')
  })

  it('propagates server abort reasons to stream consumers', async () => {
    const core = new MockCore()
    const rpcLayer = createRpcLayer(
      core as any,
      { addServerBlobStream: vi.fn() } as any,
      new BaseClientTransformer(),
    )

    const streamPromise = rpcLayer.call(
      'users/profile',
      { userId: '1' },
      { _stream_response: true },
    )

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamResponse, callId: 0 },
      new Uint8Array([1]),
    )

    const iterable = await streamPromise
    const iterator = iterable[Symbol.asyncIterator]()
    const nextPromise = iterator.next()

    core.emit(
      'message',
      {
        type: ServerMessageType.RpcStreamAbort,
        callId: 0,
        reason: 'server cancelled',
      },
      new Uint8Array([2]),
    )

    await expect(nextPromise).rejects.toBe('server cancelled')
  })
})
