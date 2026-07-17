import type { BaseClientFormat } from '@nmtjs/protocol/client'
import {
  ClientMessageType,
  ConnectionType,
  ErrorCode,
  ServerMessageType,
} from '@nmtjs/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const createLayer = () => {
  const core = new MockCore()
  const rpcLayer = createRpcLayer(
    core as any,
    { addServerBlobStream: vi.fn() } as any,
    new BaseClientTransformer(),
  )
  return { core, rpcLayer }
}

// #211: a response frame the server never sent — or one the client failed to
// decode, which cannot be attributed to a callId — must not pin a default
// no-timeout call forever
describe('RPC default response timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a no-timeout call whose response never arrives', async () => {
    const { core, rpcLayer } = createLayer()

    const promise = rpcLayer.call('users/profile', { userId: '1' })
    const assertion = expect(promise).rejects.toMatchObject({
      code: ErrorCode.RequestTimeout,
      message: 'Response timeout',
    })

    await vi.advanceTimersByTimeAsync(30_000)
    await assertion

    // the server is told to drop the call, and no state is leaked
    expect(core.protocol.encodeMessage).toHaveBeenCalledWith(
      expect.anything(),
      ClientMessageType.RpcAbort,
      expect.objectContaining({ callId: 0 }),
    )
    expect(rpcLayer.pendingCallCount).toBe(0)
  })

  it('does not fire once the call has settled', async () => {
    const { core, rpcLayer } = createLayer()

    const promise = rpcLayer.call('users/profile', { userId: '1' })
    await vi.advanceTimersByTimeAsync(0)

    core.emit(
      'message',
      { type: ServerMessageType.RpcResponse, callId: 0, result: { ok: true } },
      new Uint8Array([1]),
    )
    await expect(promise).resolves.toEqual({ ok: true })

    core.protocol.encodeMessage.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(core.protocol.encodeMessage).not.toHaveBeenCalled()
  })

  it('does not tear down a long-lived stream after the deadline', async () => {
    const { core, rpcLayer } = createLayer()

    const streamPromise = rpcLayer.call(
      'users/profile',
      { userId: '1' },
      { _stream_response: true },
    )
    await vi.advanceTimersByTimeAsync(0)

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamResponse, callId: 0 },
      new Uint8Array([1]),
    )
    const iterable = await streamPromise

    core.protocol.encodeMessage.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(core.protocol.encodeMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      ClientMessageType.RpcAbort,
      expect.anything(),
    )

    // the stream still delivers data well past the deadline
    const iterator = iterable[Symbol.asyncIterator]()
    const chunkPromise = iterator.next()
    await vi.advanceTimersByTimeAsync(0)
    core.emit(
      'message',
      {
        type: ServerMessageType.RpcStreamChunk,
        callId: 0,
        chunk: encodeJson({ ok: true }),
      },
      new Uint8Array([2]),
    )
    await expect(chunkPromise).resolves.toEqual({
      done: false,
      value: { ok: true },
    })
  })

  it('is disabled entirely with timeout: 0', async () => {
    const { core, rpcLayer } = createLayer()

    const promise = rpcLayer.call(
      'users/profile',
      { userId: '1' },
      { timeout: 0 },
    )

    await vi.advanceTimersByTimeAsync(120_000)
    expect(rpcLayer.pendingCallCount).toBe(1)

    core.emit(
      'message',
      { type: ServerMessageType.RpcResponse, callId: 0, result: { ok: true } },
      new Uint8Array([1]),
    )
    await expect(promise).resolves.toEqual({ ok: true })
  })
})
