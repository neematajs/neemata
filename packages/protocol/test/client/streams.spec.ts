import { describe, expect, it, vi } from 'vitest'

import {
  ProtocolClientBlobStream,
  ProtocolServerBlobStream,
  ProtocolServerStream,
} from '../../src/client/stream.ts'
import { ClientStreams, ServerStreams } from '../../src/client/streams.ts'

const encoder = new TextEncoder()
const decoder = new TextADecoder()

const readableFrom = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })

describe('ProtocolClientBlobStream', () => {
  it('buffers chunks until requested size', async () => {
    const stream = new ProtocolClientBlobStream(
      readableFrom(['hello', 'world']),
      1,
      { type: 'text/plain' },
    )

    const chunk1 = await stream.read(5)
    expect(decoder.decode(chunk1!)).toBe('hello')

    const chunk2 = await stream.read(5)
    expect(decoder.decode(chunk2!)).toBe('world')

    const chunk3 = await stream.read(1)
    expect(chunk3).toBeNull()
  })
})

describe('ProtocolServerStream', () => {
  it('consumes pushed chunks via async iterator', async () => {
    const stream = new ProtocolServerStream<Uint8Array>()

    const collect = (async () => {
      const chunks: Uint8Array[] = []
      for await (const chunk of stream) chunks.push(chunk)
      return chunks
    })()

    stream.push(encoder.encode('foo'))
    stream.push(encoder.encode('bar'))
    stream.end()

    const result = await collect
    expect(result.map((chunk) => decoder.decode(chunk))).toEqual(['foo', 'bar'])
  })
})

describe('ProtocolServerBlobStream', () => {
  it('requests chunks via provided pull handler', async () => {
    let blobStream: ProtocolServerBlobStream
    const pull = vi.fn((size: number | null) => {
      expect(size).toBeGreaterThan(0)
      if (pull.mock.calls.length === 1) {
        blobStream.push(encoder.encode('chunk'))
      } else {
        blobStream.end()
      }
    })

    blobStream = new ProtocolServerBlobStream({ type: 'text/plain' }, { pull })

    const reader = blobStream.readable.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(decoder.decode(first.value!)).toBe('chunk')

    const second = await reader.read()
    expect(second.done).toBe(true)
    expect(pull).toHaveBeenCalled()
  })
})

describe('ClientStreams collection', () => {
  it('adds streams and supports pull/end lifecycle', async () => {
    const registry = new ClientStreams()
    const stream = registry.add(readableFrom(['payload']), 10, {
      type: 'text/plain',
    })
    expect(stream.metadata.type).toBe('text/plain')

    const chunk = await registry.pull(10, 7)
    expect(decoder.decode(chunk!)).toBe('payload')

    registry.remove(10)
    expect(() => registry.get(10)).toThrow('Stream not found')
  })

  it('aborts streams and clears registry', () => {
    const registry = new ClientStreams()
    registry.add(readableFrom(['data']), 1, { type: 'text/plain' })
    registry.abort(1, new Error('abort'))
    expect(() => registry.get(1)).toThrow('Stream not found')

    registry.add(readableFrom(['data']), 2, { type: 'text/plain' })
    registry.clear(new Error('clear'))
    expect(() => registry.get(2)).toThrow('Stream not found')
  })
})

describe('ServerStreams collection', () => {
  it('pushes, ends, and removes streams', async () => {
    const registry = new ServerStreams()
    const stream = { push: vi.fn(), end: vi.fn(), abort: vi.fn() }
    registry.add(5, stream as any)

    await registry.push(5, encoder.encode('chunk'))
    expect(stream.push).toHaveBeenCalled()

    registry.end(5)
    expect(stream.end).toHaveBeenCalled()
    expect(() => registry.get(5)).toThrow('Stream not found')
  })

  it('aborts and clears all streams', () => {
    const registry = new ServerStreams()
    const streamA = { push: vi.fn(), end: vi.fn(), abort: vi.fn() }
    const streamB = { push: vi.fn(), end: vi.fn(), abort: vi.fn() }
    registry.add(1, streamA as any)
    registry.add(2, streamB as any)

    registry.abort(1)
    expect(streamA.abort).toHaveBeenCalled()

    const clearError = new Error('clear')
    registry.clear(clearError)
    expect(streamB.abort).toHaveBeenCalledWith(clearError)
    expect(() => registry.get(2)).toThrow('Stream not found')
  })
})
