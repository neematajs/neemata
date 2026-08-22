import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { GatewayInjectables as injectables } from '@nmtjs/gateway'
import { createProtocolBlobReference, ServerMessageType } from '@nmtjs/protocol'
import { describe, expect, it } from 'vitest'

import {
  STREAM_CREDIT_VIOLATION_REASON,
  STREAM_IDLE_TIMEOUT_REASON,
  STREAM_TRANSPORT_DROP_REASON,
} from '../../src/ws/streams.ts'
import {
  createEngineHarness as createTestGateway,
  encodeClientBlobPush,
  encodeRpcAbort,
  encodeRpcMessage,
  encodeRpcStreamPull,
  encodeServerBlobPull,
  flush,
  sleep,
} from './_helpers/engine.ts'

describe('RPC stream flow control', () => {
  it('gates chunks on RpcStreamPull credits', async () => {
    let finished = false
    let advanced = 0
    async function* handler() {
      try {
        advanced++
        yield 'a'
        advanced++
        yield 'b'
        advanced++
        yield 'c'
      } finally {
        finished = true
      }
    }

    const { sentOfType, send, stop } = await createTestGateway({
      call: async () => () => handler(),
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()

    expect(sentOfType(ServerMessageType.RpcStreamResponse).length).toBe(1)
    // no credit yet: no chunk may be sent and the producer must not even
    // have been advanced (no prefetch before the first pull)
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(0)
    expect(advanced).toBe(0)

    await send(encodeRpcStreamPull(1, 1))
    await flush()
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(1)
    expect(
      JSON.parse(sentOfType(ServerMessageType.RpcStreamChunk)[0].rest as any),
    ).toBe('a')
    // exactly one credit = exactly one producer advance
    expect(advanced).toBe(1)

    await send(encodeRpcStreamPull(1, 2))
    await flush()
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(3)
    // the End still needs one more credit: the consumer's final read
    expect(sentOfType(ServerMessageType.RpcStreamEnd).length).toBe(0)

    await send(encodeRpcStreamPull(1, 1))
    await flush()
    expect(sentOfType(ServerMessageType.RpcStreamEnd).length).toBe(1)
    expect(finished).toBe(true)

    await inFlight
    await stop()
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

    const { engine, sentOfType, send, connection, stop } =
      await createTestGateway({
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
    expect(engine.rpcs.get(connection.id, 1)).toBeUndefined()

    await stop()
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

    const { send, stop } = await createTestGateway({
      call: async () => () => handler(),
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()
    // one credit so the generator actually starts (and has cleanup to run)
    await send(encodeRpcStreamPull(1, 1))
    await flush()

    // the loop is parked waiting for more credit; teardown must release it
    await stop()
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

    const { sentOfType, send, stop } = await createTestGateway({
      call: async () => () => handler(),
      sendResult: (message) =>
        message.type === ServerMessageType.RpcStreamChunk
          ? 'dropped'
          : 'delivered',
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

    await stop()
  })

  it('reaps a stream whose consumer never pulls via the idle timeout', async () => {
    let advanced = false
    // never-yielding producer + never-iterating client: without the credit
    // gate before next() this state had no timer and leaked forever
    async function* handler() {
      advanced = true
      await new Promise(() => {})
      yield 'never'
    }

    const { engine, sentOfType, send, connection, stop } =
      await createTestGateway({
        call: async () => () => handler(),
        streamIdleTimeout: 50,
      })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await inFlight

    const aborts = sentOfType(ServerMessageType.RpcStreamAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].rest.toString()).toBe(STREAM_IDLE_TIMEOUT_REASON)
    // the producer was never advanced and the reservation is released
    expect(advanced).toBe(false)
    expect(engine.rpcs.get(connection.id, 1)).toBeUndefined()

    await stop()
  })

  it('terminates a handler stalled inside next() on client abort', async () => {
    let finished = false
    let releaseStall!: () => void
    const stall = new Promise<void>((resolve) => {
      releaseStall = resolve
    })
    async function* handler() {
      try {
        yield 'first'
        await stall
        yield 'second'
      } finally {
        finished = true
      }
    }

    const { sentOfType, send, stop } = await createTestGateway({
      call: async () => () => handler(),
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()
    await send(encodeRpcStreamPull(1, 2))
    await flush()

    // first chunk delivered, second next() is parked on the stalled await
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(1)

    await send(encodeRpcAbort(1))
    await flush()

    // the abort escapes the stalled next() immediately...
    expect(sentOfType(ServerMessageType.RpcStreamAbort).length).toBe(1)
    // ...while the handler itself can only unwind cooperatively
    expect(finished).toBe(false)

    releaseStall()
    await inFlight
    expect(finished).toBe(true)

    await stop()
  })

  it('does not reap a stalled producer holding outstanding credit', async () => {
    let finished = false
    let releaseStall!: () => void
    const stall = new Promise<void>((resolve) => {
      releaseStall = resolve
    })
    async function* handler() {
      try {
        yield 'first'
        await stall
        yield 'second'
      } finally {
        finished = true
      }
    }

    const { sentOfType, send, stop } = await createTestGateway({
      call: async () => () => handler(),
      streamIdleTimeout: 50,
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()
    // enough credit that the loop parks in next(), not in the credit wait
    await send(encodeRpcStreamPull(1, 5))
    await flush()
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(1)

    // sparse producers (e.g. subscription streams) may be silent far longer
    // than the idle timeout; the client is waiting, so nothing is reaped
    await sleep(120)
    expect(sentOfType(ServerMessageType.RpcStreamAbort).length).toBe(0)
    expect(finished).toBe(false)

    releaseStall()
    await inFlight
    expect(finished).toBe(true)
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(2)
    expect(sentOfType(ServerMessageType.RpcStreamEnd).length).toBe(1)
    expect(sentOfType(ServerMessageType.RpcStreamAbort).length).toBe(0)

    await stop()
  })

  it('still reaps a consumer that stops pulling mid-stream', async () => {
    let finished = false
    async function* handler() {
      try {
        while (true) yield 'tick'
      } finally {
        finished = true
      }
    }

    const { sentOfType, send, stop } = await createTestGateway({
      call: async () => () => handler(),
      streamIdleTimeout: 50,
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()
    // consume one chunk, then go silent
    await send(encodeRpcStreamPull(1, 1))
    await inFlight

    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(1)
    const aborts = sentOfType(ServerMessageType.RpcStreamAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].rest.toString()).toBe(STREAM_IDLE_TIMEOUT_REASON)
    expect(finished).toBe(true)

    await stop()
  })

  it('closes the connection when the RpcStreamResponse frame is dropped', async () => {
    let started = false
    async function* handler() {
      started = true
      yield 'never'
    }

    const { sentOfType, send, close, stop } = await createTestGateway({
      call: async () => () => handler(),
      sendResult: (message) =>
        message.type === ServerMessageType.RpcStreamResponse
          ? 'dropped'
          : 'delivered',
    })

    await send(encodeRpcMessage(1, 'test', {}))
    await flush()

    // the producer was never advanced and no stream frames followed
    expect(started).toBe(false)
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(0)
    expect(sentOfType(ServerMessageType.RpcStreamAbort).length).toBe(0)
    expect(close).toHaveBeenCalled()

    await stop()
  })

  it('does not lose a grant delivered synchronously with the stream response', async () => {
    async function* handler() {
      yield 'a'
    }

    let sendNow: ((data: Buffer) => Promise<void>) | null = null

    const { sentOfType, send, stop } = await createTestGateway({
      call: async () => () => handler(),
      onSend: (message) => {
        // simulate an in-process transport delivering pulls re-entrantly:
        // the first before the response send even returns, the next one
        // (the consumer's final read) inside the chunk send
        if (
          message.type === ServerMessageType.RpcStreamResponse ||
          message.type === ServerMessageType.RpcStreamChunk
        ) {
          void sendNow?.(encodeRpcStreamPull(1, 1))
        }
      },
    })
    sendNow = send

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()

    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(1)
    expect(sentOfType(ServerMessageType.RpcStreamEnd).length).toBe(1)
    expect(sentOfType(ServerMessageType.RpcStreamAbort).length).toBe(0)

    await inFlight
    await stop()
  })

  it('aborts the stream on a zero-size RpcStreamPull', async () => {
    let finished = false
    async function* handler() {
      try {
        while (true) yield 'tick'
      } finally {
        finished = true
      }
    }

    const { sentOfType, send, stop } = await createTestGateway({
      call: async () => () => handler(),
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()
    // a valid credit first, so the generator starts and has cleanup to run
    await send(encodeRpcStreamPull(1, 1))
    await flush()
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(1)

    await send(encodeRpcStreamPull(1, 0))
    await inFlight

    expect(finished).toBe(true)
    const aborts = sentOfType(ServerMessageType.RpcStreamAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].rest.toString()).toBe(STREAM_CREDIT_VIOLATION_REASON)

    await stop()
  })

  it('aborts the stream when pull totals overflow the credit cap', async () => {
    let finished = false
    let releaseStall!: () => void
    const stall = new Promise<void>((resolve) => {
      releaseStall = resolve
    })
    async function* handler() {
      try {
        yield 'a'
        await stall
      } finally {
        finished = true
      }
    }

    const { sentOfType, send, stop } = await createTestGateway({
      call: async () => () => handler(),
    })

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    await flush()

    await send(encodeRpcStreamPull(1, 2 ** 32 - 1))
    await flush()
    expect(sentOfType(ServerMessageType.RpcStreamChunk).length).toBe(1)
    expect(sentOfType(ServerMessageType.RpcStreamAbort).length).toBe(0)

    await send(encodeRpcStreamPull(1, 2 ** 32 - 1))
    await flush()

    const aborts = sentOfType(ServerMessageType.RpcStreamAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].rest.toString()).toBe(STREAM_CREDIT_VIOLATION_REASON)

    releaseStall()
    await inFlight
    expect(finished).toBe(true)

    await stop()
  })
})

describe('Upload stream flow control', () => {
  it('aborts an upload stream on a push exceeding granted credit', async () => {
    // hold the call in flight so its streams stay alive
    let release!: () => void
    const pending = new Promise<null>((resolve) => {
      release = () => resolve(null)
    })

    const { engine, sentOfType, send, stop } = await createTestGateway({
      call: async () => pending,
    })

    const inFlight = send(encodeRpcMessage(1, 'test', { __stream: 7 }))
    await flush()

    // no ClientBlobPull was ever sent: any push violates the credit
    await send(encodeClientBlobPush(7, Buffer.from('overflow')))

    const aborts = sentOfType(ServerMessageType.ClientBlobAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].id).toBe(7)
    expect(aborts[0].rest.toString()).toBe(STREAM_CREDIT_VIOLATION_REASON)
    expect(engine.blobStreams.clientStreams.size).toBe(0)

    release()
    await inFlight

    // still exactly one wire abort for this stream
    expect(sentOfType(ServerMessageType.ClientBlobAbort).length).toBe(1)

    await stop()
  })

  it('rolls back the grant and aborts when the pull frame is dropped', async () => {
    const { engine, sentOfType, send, stop } = await createTestGateway({
      call: async ({ container }) => {
        const consumeBlob = await container.resolve(injectables.consumeBlob)
        const stream = consumeBlob(
          createProtocolBlobReference(7, { type: 'application/octet-stream' }),
        )
        // start consuming: _read demand triggers the (dropped) pull
        stream.on('data', () => {})
        stream.on('error', () => {})
        await new Promise<void>((resolve) => setImmediate(resolve))
        return null
      },
      sendResult: (message) =>
        message.type === ServerMessageType.ClientBlobPull
          ? 'dropped'
          : 'delivered',
    })

    await send(encodeRpcMessage(1, 'test', { __stream: 7 }))
    await flush()

    expect(sentOfType(ServerMessageType.ClientBlobPull).length).toBe(1)
    const aborts = sentOfType(ServerMessageType.ClientBlobAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].id).toBe(7)
    expect(aborts[0].rest.toString()).toBe(STREAM_TRANSPORT_DROP_REASON)
    expect(engine.blobStreams.clientStreams.size).toBe(0)

    await stop()
  })

  it('sends the idle timeout reason on the wire, exactly once', async () => {
    let release!: () => void
    const pending = new Promise<null>((resolve) => {
      release = () => resolve(null)
    })

    const { sentOfType, send, stop } = await createTestGateway({
      call: async () => pending,
      streamIdleTimeout: 50,
    })

    const inFlight = send(encodeRpcMessage(1, 'test', { __stream: 9 }))
    await sleep(120)

    let aborts = sentOfType(ServerMessageType.ClientBlobAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].id).toBe(9)
    expect(aborts[0].rest.toString()).toBe(STREAM_IDLE_TIMEOUT_REASON)

    // the dispose path must not send a second abort for the same stream
    release()
    await inFlight
    aborts = sentOfType(ServerMessageType.ClientBlobAbort)
    expect(aborts.length).toBe(1)

    await stop()
  })
})

describe('Download stream flow control', () => {
  it('sends pushes only against granted byte credits', async () => {
    const { engine, sentOfType, send, stop } = await createTestGateway({
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
    expect(sentOfType(ServerMessageType.ServerBlobPush).length).toBe(0)

    await send(encodeServerBlobPull(0, 10))
    await flush()

    let pushes = sentOfType(ServerMessageType.ServerBlobPush)
    expect(pushes.length).toBe(1)
    expect(pushes[0].rest.byteLength).toBe(10)

    await send(encodeServerBlobPull(0, 90))
    await flush()

    pushes = sentOfType(ServerMessageType.ServerBlobPush)
    expect(Buffer.concat(pushes.map((p) => p.rest)).byteLength).toBe(100)
    expect(sentOfType(ServerMessageType.ServerBlobEnd).length).toBe(1)
    expect(engine.blobStreams.serverStreams.size).toBe(0)

    await stop()
  })

  it('closes the connection when a terminal ServerBlobEnd frame is dropped', async () => {
    const { engine, sentOfType, send, close, stop } = await createTestGateway({
      call: async ({ container }) => {
        const createBlob = await container.resolve(injectables.createBlob)
        createBlob(Readable.from([Buffer.alloc(10)]), {
          type: 'application/octet-stream',
          size: 10,
        })
        return null
      },
      sendResult: (message) =>
        message.type === ServerMessageType.ServerBlobEnd
          ? 'dropped'
          : 'delivered',
    })

    await send(encodeRpcMessage(1, 'test', {}))
    await flush()
    await send(encodeServerBlobPull(0, 100))
    await flush()

    expect(sentOfType(ServerMessageType.ServerBlobEnd).length).toBe(1)
    // the frame was dropped after local cleanup: only a connection close can
    // stop the client from waiting forever
    expect(close).toHaveBeenCalled()
    expect(engine.blobStreams.serverStreams.size).toBe(0)

    await stop()
  })

  it('aborts the stream on a zero-size ServerBlobPull', async () => {
    const { engine, sentOfType, send, stop } = await createTestGateway({
      call: async ({ container }) => {
        const createBlob = await container.resolve(injectables.createBlob)
        createBlob(Readable.from([Buffer.alloc(10)]), {
          type: 'application/octet-stream',
          size: 10,
        })
        return null
      },
    })

    await send(encodeRpcMessage(1, 'test', {}))
    await flush()
    await send(encodeServerBlobPull(0, 0))
    await flush()

    expect(sentOfType(ServerMessageType.ServerBlobPush).length).toBe(0)
    const aborts = sentOfType(ServerMessageType.ServerBlobAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].rest.toString()).toBe(STREAM_CREDIT_VIOLATION_REASON)
    expect(engine.blobStreams.serverStreams.size).toBe(0)

    await stop()
  })

  it('aborts the stream when byte-credit grants overflow the cap', async () => {
    const { engine, sentOfType, send, stop } = await createTestGateway({
      call: async ({ container }) => {
        const createBlob = await container.resolve(injectables.createBlob)
        // manual source: no data, credits just accumulate
        createBlob(new Readable({ read() {} }), {
          type: 'application/octet-stream',
        })
        return null
      },
    })

    await send(encodeRpcMessage(1, 'test', {}))
    await flush()

    await send(encodeServerBlobPull(0, 2 ** 32 - 1))
    await flush()
    expect(sentOfType(ServerMessageType.ServerBlobAbort).length).toBe(0)

    await send(encodeServerBlobPull(0, 2 ** 32 - 1))
    await flush()

    const aborts = sentOfType(ServerMessageType.ServerBlobAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].rest.toString()).toBe(STREAM_CREDIT_VIOLATION_REASON)
    expect(engine.blobStreams.serverStreams.size).toBe(0)

    await stop()
  })

  it('does not send the abort for a pre-grant source error before the pull', async () => {
    const source = new Readable({ read() {} })

    const { engine, sentOfType, send, stop } = await createTestGateway({
      call: async ({ container }) => {
        const createBlob = await container.resolve(injectables.createBlob)
        createBlob(source, { type: 'application/octet-stream' })
        return null
      },
    })

    await send(encodeRpcMessage(1, 'test', {}))
    await flush()
    expect(sentOfType(ServerMessageType.RpcResponse).length).toBe(1)

    // the source dies before the client ever pulled
    source.destroy(new Error('early failure'))
    await flush()
    expect(sentOfType(ServerMessageType.ServerBlobAbort).length).toBe(0)

    // the abort is delivered against the first grant instead
    await send(encodeServerBlobPull(0, 10))
    await flush()

    const aborts = sentOfType(ServerMessageType.ServerBlobAbort)
    expect(aborts.length).toBe(1)
    expect(aborts[0].rest.toString()).toBe('early failure')
    expect(engine.blobStreams.serverStreams.size).toBe(0)

    await stop()
  })
})
