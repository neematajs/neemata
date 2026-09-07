import type { ProtocolBlobMetadata } from '@nmtjs/protocol'
import {
  ClientMessageType,
  DEFAULT_BLOB_CHUNK_SIZE,
  DEFAULT_BLOB_CREDIT_REFILL,
  ProtocolBlob,
  ServerMessageType,
  STREAM_FLOW_CONTROL_VIOLATION_REASON,
} from '@nmtjs/protocol'
import { ProtocolServerStream } from '@nmtjs/protocol/client'
import { describe, expect, it, vi } from 'vitest'

import { EventEmitter } from '../src/events.ts'
import { createStreamLayer, toReasonString } from '../src/layers/streams.ts'
import { ClientStreams, ServerStreams } from '../src/streams.ts'

const metadata: ProtocolBlobMetadata = { type: 'application/octet-stream' }

const createReadable = (chunks: Uint8Array[], cancel = vi.fn()) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
    cancel,
  }) as unknown as ReadableStream<ArrayBufferView>

describe('ClientStreams', () => {
  describe('add', () => {
    it('should add a stream with streamId and metadata', () => {
      const streams = new ClientStreams()
      const source = createReadable([new Uint8Array([1, 2, 3])])

      const stream = streams.add(source, 1, metadata)

      expect(stream).toBeDefined()
      expect(stream.id).toBe(1)
      expect(stream.metadata).toBe(metadata)
    })
  })

  describe('get', () => {
    it('should return the stream by id', () => {
      const streams = new ClientStreams()
      const source = createReadable([])
      const added = streams.add(source, 1, metadata)

      expect(streams.get(1)).toBe(added)
    })

    it('should throw if stream not found', () => {
      const streams = new ClientStreams()

      expect(() => streams.get(999)).toThrow('Stream not found')
    })
  })

  describe('pull', () => {
    it('should pull buffered chunks from active streams', async () => {
      const streams = new ClientStreams()
      const source = createReadable([new Uint8Array([1, 2, 3])])
      streams.add(source, 1, metadata)

      const chunk = await streams.pull(1, 2)

      expect(Array.from(chunk ?? [])).toEqual([1, 2])
    })

    it('should return null when stream is exhausted', async () => {
      const streams = new ClientStreams()
      const source = createReadable([new Uint8Array([1])])
      streams.add(source, 1, metadata)

      await streams.pull(1, 1)
      const chunk = await streams.pull(1, 1)

      expect(chunk).toBeNull()
    })
  })

  describe('end', () => {
    it('should end stream and remove from collection', async () => {
      const streams = new ClientStreams()
      const source = createReadable([])
      streams.add(source, 2, metadata)

      await streams.end(2)

      expect(() => streams.get(2)).toThrow('Stream not found')
    })
  })

  describe('remove', () => {
    it('should remove stream from collection', () => {
      const streams = new ClientStreams()
      const source = createReadable([])
      streams.add(source, 3, metadata)

      streams.remove(3)

      expect(() => streams.get(3)).toThrow('Stream not found')
    })
  })

  describe('abort', () => {
    it('should abort stream with error and remove from collection', async () => {
      const cancel = vi.fn()
      const source = createReadable([new Uint8Array([1])], cancel)
      const streams = new ClientStreams()
      streams.add(source, 5, metadata)

      const error = new Error('Test abort')
      await streams.abort(5, error)

      expect(cancel).toHaveBeenCalledTimes(1)
      expect(cancel.mock.calls[0]?.[0]).toBe(error)
      expect(() => streams.get(5)).toThrow('Stream not found')
    })

    it('should abort with default error when none provided', async () => {
      const cancel = vi.fn()
      const source = createReadable([new Uint8Array([1])], cancel)
      const streams = new ClientStreams()
      streams.add(source, 5, metadata)

      await streams.abort(5)

      expect(cancel).toHaveBeenCalled()
    })

    it('removes the stream even when the source cancel rejects', async () => {
      const cancel = vi.fn(() => {
        throw new Error('cancel failed')
      })
      const source = createReadable([new Uint8Array([1])], cancel)
      const streams = new ClientStreams()
      streams.add(source, 5, metadata)

      // e.g. a server-initiated abort against a source with broken cleanup:
      // the failure surfaces, but the manager entry must not leak
      await expect(streams.abort(5, 'server abort')).rejects.toThrow(
        'cancel failed',
      )
      expect(() => streams.get(5)).toThrow('Stream not found')
    })
  })

  describe('clear', () => {
    it('should clear all streams and propagate error', async () => {
      const cancelA = vi.fn()
      const cancelB = vi.fn()
      const streams = new ClientStreams()
      streams.add(createReadable([new Uint8Array([1])], cancelA), 7, metadata)
      streams.add(createReadable([new Uint8Array([2])], cancelB), 8, metadata)

      const error = new Error('Clear all')
      await streams.clear(error)

      expect(cancelA).toHaveBeenCalledTimes(1)
      expect(cancelB).toHaveBeenCalledTimes(1)
      expect(cancelA.mock.calls[0]?.[0]).toBe(error)
      expect(cancelB.mock.calls[0]?.[0]).toBe(error)
      expect(() => streams.get(7)).toThrow('Stream not found')
      expect(() => streams.get(8)).toThrow('Stream not found')
    })

    it('should clear all streams without error', async () => {
      const streams = new ClientStreams()
      streams.add(createReadable([]), 1, metadata)
      streams.add(createReadable([]), 2, metadata)

      await streams.clear()

      expect(() => streams.get(1)).toThrow('Stream not found')
      expect(() => streams.get(2)).toThrow('Stream not found')
    })

    it('clears the rest even when one source cancel rejects', async () => {
      const rejectingCancel = vi.fn(() => {
        throw new Error('cancel failed')
      })
      const healthyCancel = vi.fn()
      const streams = new ClientStreams()
      streams.add(
        createReadable([new Uint8Array([1])], rejectingCancel),
        7,
        metadata,
      )
      streams.add(
        createReadable([new Uint8Array([2])], healthyCancel),
        8,
        metadata,
      )

      await streams.clear(new Error('shutdown'))

      expect(rejectingCancel).toHaveBeenCalledTimes(1)
      expect(healthyCancel).toHaveBeenCalledTimes(1)
      expect(() => streams.get(7)).toThrow('Stream not found')
      expect(() => streams.get(8)).toThrow('Stream not found')
    })
  })
})

describe('ServerStreams', () => {
  describe('add', () => {
    it('should add a stream with streamId', () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()

      streams.add(3, stream)

      expect(streams.get(3)).toBe(stream)
    })
  })

  describe('has', () => {
    it('should return true if stream exists', () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()
      streams.add(1, stream)

      expect(streams.has(1)).toBe(true)
    })

    it('should return false if stream does not exist', () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()

      expect(streams.has(999)).toBe(false)
    })
  })

  describe('get', () => {
    it('should return stream by id', () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()
      streams.add(1, stream)

      expect(streams.get(1)).toBe(stream)
    })

    it('should throw if stream not found', () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()

      expect(() => streams.get(999)).toThrow('Stream not found')
    })
  })

  describe('push', () => {
    it('should push chunks to registered streams', async () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()
      streams.add(3, stream)

      const chunk = new Uint8Array([9])
      const iterator = stream[Symbol.asyncIterator]()
      const readPromise = iterator.next()

      await streams.push(3, chunk)
      const { done, value } = await readPromise

      expect(done).toBe(false)
      expect(value).toEqual(chunk)

      await iterator.return?.()
    })
  })

  describe('end', () => {
    it('should end stream and remove from collection', async () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()
      streams.add(4, stream)

      await streams.end(4)

      expect(() => streams.get(4)).toThrow('Stream not found')
    })
  })

  describe('remove', () => {
    it('should remove stream from collection', () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()
      streams.add(5, stream)

      streams.remove(5)

      expect(() => streams.get(5)).toThrow('Stream not found')
    })
  })

  describe('abort', () => {
    it('should abort and remove existing stream', async () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()
      streams.add(4, stream)

      await streams.abort(4)

      expect(() => streams.get(4)).toThrow('Stream not found')
    })

    it('should not throw when aborting non-existent stream', async () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()

      await expect(streams.abort(999)).resolves.not.toThrow()
    })
  })

  describe('clear', () => {
    it('should clear all streams with propagated error', async () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const a = new ProtocolServerStream<ArrayBufferView>()
      const b = new ProtocolServerStream<ArrayBufferView>()
      streams.add(10, a)
      streams.add(11, b)

      const error = new Error('shutdown')
      await streams.clear(error)

      expect(() => streams.get(10)).toThrow('Stream not found')
      expect(() => streams.get(11)).toThrow('Stream not found')
    })

    it('should clear all streams without calling abort when no error', async () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()
      streams.add(1, stream)

      await streams.clear()

      expect(() => streams.get(1)).toThrow('Stream not found')
    })
  })
})

describe('createStreamLayer', () => {
  const createCore = () =>
    Object.assign(new EventEmitter(), {
      messageContext: {},
      protocol: {
        encodeMessage: vi.fn(
          (_context, type, payload) => ({ type, payload }) as any,
        ),
      },
      send: vi.fn(async () => {}),
      emitStreamEvent: vi.fn(),
      emitClientEvent: vi.fn(),
    })

  it('spends one byte-credit grant across multiple bounded upload frames', async () => {
    const core = createCore()
    const layer = createStreamLayer(core as any)
    const granted = 2 * DEFAULT_BLOB_CHUNK_SIZE + 17
    const stream = layer.addClientStream(
      ProtocolBlob.from(createReadable([new Uint8Array(granted)]), metadata),
    )

    core.emit('message', {
      type: ServerMessageType.ClientBlobPull,
      streamId: stream.id,
      size: granted,
    })

    await vi.waitFor(() => expect(core.send).toHaveBeenCalledTimes(3))

    const pushes = core.protocol.encodeMessage.mock.calls.filter(
      ([, type]) => type === ClientMessageType.ClientBlobPush,
    )
    expect(pushes).toHaveLength(3)
    expect(
      pushes.reduce((total, call) => total + call[2].chunk.byteLength, 0),
    ).toBe(granted)
    expect(
      Math.max(...pushes.map((call) => call[2].chunk.byteLength)),
    ).toBeLessThanOrEqual(DEFAULT_BLOB_CHUNK_SIZE)
  })

  it('accumulates grants behind one pump and emits one terminal frame', async () => {
    const core = createCore()
    const layer = createStreamLayer(core as any)
    const stream = layer.addClientStream(
      ProtocolBlob.from(createReadable([new Uint8Array(100_000)]), metadata),
    )

    core.emit('message', {
      type: ServerMessageType.ClientBlobPull,
      streamId: stream.id,
      size: DEFAULT_BLOB_CHUNK_SIZE,
    })
    core.emit('message', {
      type: ServerMessageType.ClientBlobPull,
      streamId: stream.id,
      size: DEFAULT_BLOB_CHUNK_SIZE,
    })

    await vi.waitFor(() => {
      expect(
        core.protocol.encodeMessage.mock.calls.filter(
          ([, type]) => type === ClientMessageType.ClientBlobEnd,
        ),
      ).toHaveLength(1)
    })

    const pushes = core.protocol.encodeMessage.mock.calls.filter(
      ([, type]) => type === ClientMessageType.ClientBlobPush,
    )
    expect(
      pushes.reduce((total, call) => total + call[2].chunk.byteLength, 0),
    ).toBe(100_000)
    expect(() => layer.clientStreams.get(stream.id)).toThrow('Stream not found')
  })

  it('skips empty source chunks without spending credit or aborting', async () => {
    const core = createCore()
    const layer = createStreamLayer(core as any)
    const stream = layer.addClientStream(
      ProtocolBlob.from(
        createReadable([new Uint8Array(0), new Uint8Array([1, 2, 3])]),
        metadata,
      ),
    )

    core.emit('message', {
      type: ServerMessageType.ClientBlobPull,
      streamId: stream.id,
      size: 10,
    })

    await vi.waitFor(() => {
      expect(
        core.protocol.encodeMessage.mock.calls.filter(
          ([, type]) => type === ClientMessageType.ClientBlobEnd,
        ),
      ).toHaveLength(1)
    })

    const pushes = core.protocol.encodeMessage.mock.calls.filter(
      ([, type]) => type === ClientMessageType.ClientBlobPush,
    )
    expect(pushes).toHaveLength(1)
    expect(pushes[0][2].chunk).toEqual(new Uint8Array([1, 2, 3]))
    expect(
      core.protocol.encodeMessage.mock.calls.filter(
        ([, type]) => type === ClientMessageType.ClientBlobAbort,
      ),
    ).toHaveLength(0)
  })

  it('does not echo End when a peer abort settles the pending upload read', async () => {
    const cancel = vi.fn()
    const pull = vi.fn(() => new Promise<never>(() => {}))
    const source = new ReadableStream<ArrayBufferView>({ pull, cancel })
    const core = createCore()
    const layer = createStreamLayer(core as any)
    const stream = layer.addClientStream(ProtocolBlob.from(source, metadata))

    core.emit('message', {
      type: ServerMessageType.ClientBlobPull,
      streamId: stream.id,
      size: DEFAULT_BLOB_CHUNK_SIZE,
    })
    await vi.waitFor(() => expect(pull).toHaveBeenCalled())

    core.emit('message', {
      type: ServerMessageType.ClientBlobAbort,
      streamId: stream.id,
      reason: 'server rejected upload',
    })

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(core.send).not.toHaveBeenCalled()
  })

  it('forwards a registered server blob source when it is consumed', async () => {
    const core = createCore()
    const layer = createStreamLayer(core as any)
    const { blob } = layer.addServerBlobStream(metadata, {
      source: createReadable([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
    })

    await expect(layer.consumeServerBlob(blob).bytes()).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    )
  })

  it('propagates server abort reasons to blob stream consumers', async () => {
    const core = createCore()

    const layer = createStreamLayer(core as any)
    const { blob, streamId } = layer.addServerBlobStream(metadata)
    const stream = layer.consumeServerBlob(blob)

    const iterator = stream[Symbol.asyncIterator]()
    const nextPromise = iterator.next()

    core.emit('message', {
      type: ServerMessageType.ServerBlobAbort,
      streamId,
      reason: 'quota exceeded',
    })

    await expect(nextPromise).rejects.toBe('quota exceeded')
  })

  it('refills a server blob download before its byte window is exhausted', async () => {
    const core = createCore()
    const layer = createStreamLayer(core as any)
    const blob = layer.createServerBlob(7, metadata)
    const iterator = layer.consumeServerBlob(blob)[Symbol.asyncIterator]()

    let nextChunk = iterator.next()
    await vi.waitFor(() => expect(core.send).toHaveBeenCalledTimes(1))

    const pulls = () =>
      core.protocol.encodeMessage.mock.calls.filter(
        ([, type]) => type === ClientMessageType.ServerBlobPull,
      )
    expect(pulls()[0][2]).toEqual({ streamId: 7, size: 1024 * 1024 })

    for (let index = 0; index < 9; index++) {
      const chunk = new Uint8Array(DEFAULT_BLOB_CHUNK_SIZE)
      core.emit('message', {
        type: ServerMessageType.ServerBlobPush,
        streamId: 7,
        chunk,
      })
      await expect(nextChunk).resolves.toEqual({ done: false, value: chunk })
      if (index < 8) nextChunk = iterator.next()
    }

    await vi.waitFor(() => expect(pulls()).toHaveLength(2))
    expect(pulls()[1][2]).toEqual({
      streamId: 7,
      size: DEFAULT_BLOB_CREDIT_REFILL,
    })

    core.emit('message', {
      type: ServerMessageType.ServerBlobEnd,
      streamId: 7,
    })
  })

  it('aborts a server blob download that exceeds granted credit', async () => {
    const core = createCore()
    const layer = createStreamLayer(core as any)
    const blob = layer.createServerBlob(8, metadata)
    const nextChunk = layer
      .consumeServerBlob(blob)
      [Symbol.asyncIterator]()
      .next()

    await vi.waitFor(() => expect(core.send).toHaveBeenCalledTimes(1))
    core.emit('message', {
      type: ServerMessageType.ServerBlobPush,
      streamId: 8,
      chunk: new Uint8Array(1024 * 1024 + 1),
    })

    await expect(nextChunk).rejects.toBe(STREAM_FLOW_CONTROL_VIOLATION_REASON)
    expect(core.protocol.encodeMessage).toHaveBeenCalledWith(
      expect.anything(),
      ClientMessageType.ServerBlobAbort,
      { streamId: 8, reason: STREAM_FLOW_CONTROL_VIOLATION_REASON },
    )
  })
})

describe('toReasonString', () => {
  it('coerces symbol and function reasons instead of dropping them', () => {
    expect(toReasonString(Symbol('cancelled'))).toBe('Symbol(cancelled)')
    expect(toReasonString(() => {})).toBe('[object Function]')
  })

  it('keeps existing coercions intact', () => {
    expect(toReasonString('stop')).toBe('stop')
    expect(toReasonString(new Error('boom'))).toBe('boom')
    expect(toReasonString({ code: 1 })).toBe('{"code":1}')
    expect(toReasonString(42)).toBe('42')
    expect(toReasonString(10n)).toBe('10')
    expect(toReasonString(undefined)).toBeUndefined()
    expect(toReasonString(null)).toBeUndefined()
  })
})
