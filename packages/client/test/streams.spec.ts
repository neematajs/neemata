import { ReadableStream as NodeReadableStream } from 'node:stream/web'

import type { ProtocolBlobMetadata } from '@nmtjs/protocol'
import {
  ClientStreams,
  ProtocolServerStream,
  ServerStreams,
} from '@nmtjs/protocol/client'
import { describe, expect, it, vi } from 'vitest'

const metadata: ProtocolBlobMetadata = { type: 'application/octet-stream' }

const createReadable = (chunks: Uint8Array[], cancel = vi.fn()) =>
  new NodeReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
    cancel,
  }) as unknown as ReadableStream<ArrayBufferView>

describe('ClientStreams', () => {
  it('pulls buffered chunks from active streams', async () => {
    const streams = new ClientStreams()
    const source = createReadable([new Uint8Array([1, 2, 3])])
    streams.add(source, 1, metadata)

    const chunk = await streams.pull(1, 2)
    expect(Array.from(chunk ?? [])).toEqual([1, 2])

    streams.remove(1)
    expect(() => streams.get(1)).toThrowError('Stream not found')
  })

  it('ends streams and removes entries', () => {
    const source = createReadable([])
    const streams = new ClientStreams()
    streams.add(source, 2, metadata)

    streams.end(2)
    expect(() => streams.get(2)).toThrowError('Stream not found')
  })

  it('aborts streams and removes them from the collection', async () => {
    const cancel = vi.fn()
    const source = createReadable([new Uint8Array([1])], cancel)
    const streams = new ClientStreams()
    streams.add(source, 5, metadata)

    const error = new Error('boom')
    streams.abort(5, error)
    expect(cancel).toHaveBeenCalledWith(error)
    expect(() => streams.get(5)).toThrowError('Stream not found')
  })

  it('clears all streams and propagates errors', () => {
    const cancelA = vi.fn()
    const cancelB = vi.fn()
    const streams = new ClientStreams()
    streams.add(createReadable([new Uint8Array([1])], cancelA), 7, metadata)
    streams.add(createReadable([new Uint8Array([2])], cancelB), 8, metadata)

    const error = new Error('clear')
    streams.clear(error)
    expect(cancelA).toHaveBeenCalledWith(error)
    expect(cancelB).toHaveBeenCalledWith(error)
    expect(() => streams.get(7)).toThrowError('Stream not found')
    expect(() => streams.get(8)).toThrowError('Stream not found')
  })
})

describe('ServerStreams', () => {
  it('pushes chunks to registered streams', async () => {
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

  it('aborts and removes existing streams', () => {
    const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
    const stream = new ProtocolServerStream<ArrayBufferView>()
    const abortSpy = vi.spyOn(stream, 'abort')
    streams.add(4, stream)

    streams.abort(4)
    expect(abortSpy).toHaveBeenCalled()
    expect(() => streams.get(4)).toThrowError('Stream not found')
  })

  it('clears every stream with propagated error', () => {
    const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
    const a = new ProtocolServerStream<ArrayBufferView>()
    const b = new ProtocolServerStream<ArrayBufferView>()
    const abortA = vi.spyOn(a, 'abort')
    const abortB = vi.spyOn(b, 'abort')
    streams.add(10, a)
    streams.add(11, b)

    const error = new Error('shutdown')
    streams.clear(error)
    expect(abortA).toHaveBeenCalledWith(error)
    expect(abortB).toHaveBeenCalledWith(error)
    expect(() => streams.get(10)).toThrowError('Stream not found')
    expect(() => streams.get(11)).toThrowError('Stream not found')
  })
})
