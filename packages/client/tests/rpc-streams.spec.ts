import type { BaseClientFormat } from '@nmtjs/protocol/client'
import { ConnectionType, ServerMessageType } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { EventEmitter } from '../src/events.ts'
import { createRpcLayer } from '../src/layers/rpc.ts'
import { BaseClientTransformer } from '../src/transformers.ts'

const encodeJson = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))

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
  it('does not send extra transport messages while consuming bidirectional RPC streams', async () => {
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

    const iterator = iterable[Symbol.asyncIterator]()
    const firstChunkPromise = iterator.next()

    await Promise.resolve()
    expect(core.send).not.toHaveBeenCalled()

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
    expect(core.send).not.toHaveBeenCalled()

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamEnd, callId: 0 },
      new Uint8Array([3]),
    )

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
    expect(core.send).not.toHaveBeenCalled()
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
    expect(core.send).not.toHaveBeenCalled()

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
    expect(core.send).not.toHaveBeenCalled()

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamEnd, callId: 0 },
      new Uint8Array([3]),
    )

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })
})
