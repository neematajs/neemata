import { describe, expect, it, vi } from 'vitest'

import { ClientStreams, ServerStreams } from '../../../client/src/streams.ts'
import {
  ProtocolClientBlobStream,
  ProtocolServerBlobStream,
  ProtocolServerStream,
} from '../../src/client/stream.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const writeAndClose = async <T>(writable: WritableStream<T>, chunks: T[]) => {
  const writer = writable.getWriter()
  for (const chunk of chunks) await writer.write(chunk)
  await writer.close()
  writer.releaseLock()
}

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

    await writeAndClose(stream.writable, [
      encoder.encode('foo'),
      encoder.encode('bar'),
    ])

    const result = await collect
    expect(result.map((chunk) => decoder.decode(chunk))).toEqual(['foo', 'bar'])
  })
})

describe('ProtocolServerBlobStream', () => {
  it('requests chunks via provided pull handler', async () => {
    let writer: WritableStreamDefaultWriter | null = null
    const pull = vi.fn(async (controller: ReadableStreamDefaultController) => {
      const size = controller.desiredSize
      expect(size).toBeGreaterThan(0)
      if (pull.mock.calls.length === 1) {
        await writer!.write(encoder.encode('chunk'))
      } else {
        await writer!.close()
        writer!.releaseLock()
      }
    })

    const blobStream = new ProtocolServerBlobStream(
      { type: 'text/plain' },
      { pull },
    )
    writer = blobStream.writable.getWriter()

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

  it('aborts streams and clears registry', async () => {
    const registry = new ClientStreams()
    registry.add(readableFrom(['data']), 1, { type: 'text/plain' })
    await registry.abort(1, new Error('abort'))
    expect(() => registry.get(1)).toThrow('Stream not found')

    registry.add(readableFrom(['data']), 2, { type: 'text/plain' })
    await registry.clear(new Error('clear'))
    expect(() => registry.get(2)).toThrow('Stream not found')
  })
})

describe('ServerStreams collection', () => {
  it('pushes, ends, and removes streams', async () => {
    const registry = new ServerStreams()
    const stream = new ProtocolServerStream()
    registry.add(5, stream)

    // Collect chunks in background
    const collect = (async () => {
      const chunks: Uint8Array[] = []
      for await (const chunk of stream) chunks.push(chunk as Uint8Array)
      return chunks
    })()

    await registry.push(5, encoder.encode('chunk'))
    await registry.end(5)

    const result = await collect
    expect(result.map((c) => decoder.decode(c))).toEqual(['chunk'])
    expect(() => registry.get(5)).toThrow('Stream not found')
  })

  it('aborts and clears all streams', async () => {
    const registry = new ServerStreams()
    const streamA = new ProtocolServerStream()
    const streamB = new ProtocolServerStream()
    registry.add(1, streamA)
    registry.add(2, streamB)

    await registry.abort(1)
    expect(() => registry.get(1)).toThrow('Stream not found')

    const clearError = new Error('clear')
    await registry.clear(clearError)
    expect(() => registry.get(2)).toThrow('Stream not found')
  })
})
