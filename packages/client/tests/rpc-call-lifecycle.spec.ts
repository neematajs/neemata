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

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

class MockCore extends EventEmitter<{
  message: [message: unknown, raw: ArrayBufferView]
  connected: []
  disconnected: [reason: string]
  state_changed: [state: string, previous: string]
  pong: [nonce: number]
}> {
  readonly state = 'connected'
  readonly application = undefined
  readonly auth = undefined
  readonly connectionSignal = undefined
  readonly messageContext = {} as any

  constructor(readonly transportType = ConnectionType.Bidirectional) {
    super()
  }

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

  countSentAborts() {
    return this.protocol.encodeMessage.mock.calls.filter(
      ([, type]: [unknown, number]) => type === ClientMessageType.RpcAbort,
    ).length
  }
}

const createLayer = (core: MockCore) =>
  createRpcLayer(
    core as any,
    { addServerBlobStream: vi.fn() } as any,
    new BaseClientTransformer(),
  )

describe('RPC call signal lifecycle', () => {
  it('sends no RpcAbort for settled unary calls, even with a timeout configured', async () => {
    const core = new MockCore()
    const rpcLayer = createLayer(core)

    // success path
    const okPromise = rpcLayer.call('users/get', { id: 1 }, { timeout: 30 })
    core.emit(
      'message',
      { type: ServerMessageType.RpcResponse, callId: 0, result: { ok: true } },
      new Uint8Array([1]),
    )
    await expect(okPromise).resolves.toEqual({ ok: true })

    // failure path
    const failPromise = rpcLayer.call('users/get', { id: 2 }, { timeout: 30 })
    core.emit(
      'message',
      {
        type: ServerMessageType.RpcResponse,
        callId: 1,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' },
      },
      new Uint8Array([1]),
    )
    await expect(failPromise).rejects.toThrow('boom')

    // let the configured timeout elapse: neither settlement cleanup nor the
    // stale timer may produce an abort frame
    await wait(60)
    expect(core.countSentAborts()).toBe(0)
  })

  it('does not kill a healthy stream after the request timeout elapses (bidirectional)', async () => {
    const core = new MockCore()
    const rpcLayer = createLayer(core)

    const streamPromise = rpcLayer.call(
      'users/feed',
      {},
      { _stream_response: true, timeout: 30 },
    )

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamResponse, callId: 0 },
      new Uint8Array([1]),
    )

    const iterable = await streamPromise
    const iterator = iterable[Symbol.asyncIterator]()

    // the request timeout covers only the pending phase — the live stream
    // must survive well past it
    await wait(60)

    const chunkPromise = iterator.next()
    await Promise.resolve()
    core.emit(
      'message',
      {
        type: ServerMessageType.RpcStreamChunk,
        callId: 0,
        chunk: encodeJson({ n: 1 }),
      },
      new Uint8Array([2]),
    )

    await expect(chunkPromise).resolves.toEqual({
      done: false,
      value: { n: 1 },
    })
    expect(core.countSentAborts()).toBe(0)
  })

  it('does not kill a healthy stream after the request timeout elapses (unidirectional)', async () => {
    let bodyController!: ReadableStreamDefaultController<Uint8Array>
    let cancelled: unknown = null
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        bodyController = controller
      },
      cancel: (reason) => {
        cancelled = reason ?? 'cancelled'
      },
    })

    const core = new MockCore(ConnectionType.Unidirectional)
    core.transportCall.mockResolvedValue({ type: 'rpc_stream', stream: body })
    const rpcLayer = createLayer(core)

    const iterable = await rpcLayer.call(
      'users/feed',
      {},
      { _stream_response: true, timeout: 30 },
    )
    const iterator = iterable[Symbol.asyncIterator]()

    await wait(60)

    const chunkPromise = iterator.next()
    bodyController.enqueue(encodeJson({ n: 1 }))
    await expect(chunkPromise).resolves.toEqual({
      done: false,
      value: { n: 1 },
    })

    // the fetch body reader must not have been cancelled by the stale timer
    expect(cancelled).toBeNull()

    bodyController.close()
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it('sends exactly one RpcAbort when the consumer cancels a stream', async () => {
    const core = new MockCore()
    const rpcLayer = createLayer(core)

    const streamPromise = rpcLayer.call(
      'users/feed',
      {},
      { _stream_response: true, timeout: 30 },
    )

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamResponse, callId: 0 },
      new Uint8Array([1]),
    )

    const iterable = await streamPromise
    const iterator = iterable[Symbol.asyncIterator]()

    await iterator.return?.(undefined)
    expect(core.countSentAborts()).toBe(1)

    // no second frame later from the timeout or leftover listeners
    await wait(60)
    expect(core.countSentAborts()).toBe(1)
  })

  it('aborts a call that times out while still pending', async () => {
    const core = new MockCore()
    const rpcLayer = createLayer(core)

    const promise = rpcLayer.call('users/get', { id: 1 }, { timeout: 20 })

    await expect(promise).rejects.toThrow()
    expect(core.countSentAborts()).toBe(1)
  })

  it('sends no RpcAbort when the user signal fires after the stream completed', async () => {
    const core = new MockCore()
    const rpcLayer = createLayer(core)
    const abortController = new AbortController()

    const streamPromise = rpcLayer.call(
      'users/feed',
      {},
      { _stream_response: true, signal: abortController.signal },
    )

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamResponse, callId: 0 },
      new Uint8Array([1]),
    )

    const iterable = await streamPromise
    const iterator = iterable[Symbol.asyncIterator]()
    const endPromise = iterator.next()
    await Promise.resolve()

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamEnd, callId: 0 },
      new Uint8Array([2]),
    )
    await expect(endPromise).resolves.toEqual({ done: true, value: undefined })

    // the call is fully done: an abort of the (reused) user signal must not
    // emit a frame for the already-deleted callId
    abortController.abort('done with all calls')
    await wait(10)
    expect(core.countSentAborts()).toBe(0)
  })

  it('does not kill an autoReconnect stream via the initial attempt timeout', async () => {
    const core = new MockCore()
    const rpcLayer = createLayer(core)

    const streamPromise = rpcLayer.call(
      'users/feed',
      {},
      { _stream_response: true, autoReconnect: true, timeout: 30 },
    )

    core.emit(
      'message',
      { type: ServerMessageType.RpcStreamResponse, callId: 0 },
      new Uint8Array([1]),
    )

    const iterable = await streamPromise
    const iterator = iterable[Symbol.asyncIterator]()

    await wait(60)

    const chunkPromise = iterator.next()
    await Promise.resolve()
    core.emit(
      'message',
      {
        type: ServerMessageType.RpcStreamChunk,
        callId: 0,
        chunk: encodeJson({ n: 1 }),
      },
      new Uint8Array([2]),
    )

    await expect(chunkPromise).resolves.toEqual({
      done: false,
      value: { n: 1 },
    })
    expect(core.countSentAborts()).toBe(0)
  })
})
