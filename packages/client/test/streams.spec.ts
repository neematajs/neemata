import type { ProtocolBlobMetadata } from '@nmtjs/protocol'
import { ProtocolServerStream } from '@nmtjs/protocol/client'
import { describe, expect, it, vi } from 'vitest'

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

      expect(() => streams.get(999)).toThrowError('Stream not found')
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

      // Read all data
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

      expect(() => streams.get(2)).toThrowError('Stream not found')
    })
  })

  describe('remove', () => {
    it('should remove stream from collection', () => {
      const streams = new ClientStreams()
      const source = createReadable([])
      streams.add(source, 3, metadata)

      streams.remove(3)

      expect(() => streams.get(3)).toThrowError('Stream not found')
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

      expect(cancel).toHaveBeenCalledWith(error)
      expect(() => streams.get(5)).toThrowError('Stream not found')
    })

    it('should abort with default error when none provided', async () => {
      const cancel = vi.fn()
      const source = createReadable([new Uint8Array([1])], cancel)
      const streams = new ClientStreams()
      streams.add(source, 5, metadata)

      await streams.abort(5)

      expect(cancel).toHaveBeenCalled()
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

      expect(cancelA).toHaveBeenCalledWith(error)
      expect(cancelB).toHaveBeenCalledWith(error)
      expect(() => streams.get(7)).toThrowError('Stream not found')
      expect(() => streams.get(8)).toThrowError('Stream not found')
    })

    it('should clear all streams without error', () => {
      const streams = new ClientStreams()
      streams.add(createReadable([]), 1, metadata)
      streams.add(createReadable([]), 2, metadata)

      streams.clear()

      expect(() => streams.get(1)).toThrowError('Stream not found')
      expect(() => streams.get(2)).toThrowError('Stream not found')
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

      expect(() => streams.get(999)).toThrowError('Stream not found')
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

      expect(() => streams.get(4)).toThrowError('Stream not found')
    })
  })

  describe('remove', () => {
    it('should remove stream from collection', () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()
      streams.add(5, stream)

      streams.remove(5)

      expect(() => streams.get(5)).toThrowError('Stream not found')
    })
  })

  describe('abort', () => {
    it('should abort and remove existing stream', async () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()
      streams.add(4, stream)

      await streams.abort(4)

      expect(() => streams.get(4)).toThrowError('Stream not found')
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

      expect(() => streams.get(10)).toThrowError('Stream not found')
      expect(() => streams.get(11)).toThrowError('Stream not found')
    })

    it('should clear all streams without calling abort when no error', async () => {
      const streams = new ServerStreams<ProtocolServerStream<ArrayBufferView>>()
      const stream = new ProtocolServerStream<ArrayBufferView>()
      streams.add(1, stream)

      await streams.clear()

      expect(() => streams.get(1)).toThrowError('Stream not found')
    })
  })
})
