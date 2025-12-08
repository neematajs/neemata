import { describe, expect, it, vi } from 'vitest'

import { DuplexStream } from '../src/streams.ts'

const writeAndClose = async <T>(writable: WritableStream<T>, chunks: T[]) => {
  const writer = writable.getWriter()
  for (const chunk of chunks) await writer.write(chunk)
  await writer.close()
  writer.releaseLock()
}

const writeAndAbort = async <T>(
  writable: WritableStream<T>,
  chunks: T[],
  error?: Error,
) => {
  const writer = writable.getWriter()
  for (const chunk of chunks) await writer.write(chunk)
  await writer.abort(error ?? new Error('Stream aborted'))
  writer.releaseLock()
}

describe('DuplexStream', () => {
  it('should push and read chunks', async () => {
    const stream = new DuplexStream<string>()

    setTimeout(async () => {
      await writeAndClose(stream.writable, ['hello', 'world'])
    }, 1)

    const reader = stream.readable.getReader()
    const chunks: string[] = []

    let result = await reader.read()
    while (!result.done) {
      chunks.push(result.value)
      result = await reader.read()
    }

    expect(chunks).toEqual(['hello', 'world'])
  })

  it('should transform chunks', async () => {
    const stream = new DuplexStream<number, string>({
      transform: (chunk) => chunk.length,
    })

    setTimeout(async () => {
      await writeAndClose(stream.writable, ['hello', 'hi'])
    })

    const reader = stream.readable.getReader()
    const chunks: number[] = []

    let result = await reader.read()
    while (!result.done) {
      chunks.push(result.value)
      result = await reader.read()
    }

    expect(chunks).toEqual([5, 2])
  })

  it('should call start callback', async () => {
    const start = vi.fn()
    const stream = new DuplexStream({ start })

    // Start is called when readable is accessed/used
    stream.readable.getReader()

    expect(start).toHaveBeenCalledOnce()
  })

  it('should call close callback on end', async () => {
    const close = vi.fn()
    const stream = new DuplexStream({ close })

    const writer = stream.writable.getWriter()
    await writer.close()
    writer.releaseLock()

    expect(close).toHaveBeenCalledOnce()
  })

  it('should call cancel callback when readable is cancelled', async () => {
    const cancel = vi.fn()
    const stream = new DuplexStream({ cancel })

    const reader = stream.readable.getReader()
    await reader.cancel('test reason')

    expect(cancel).toHaveBeenCalledWith('test reason')
  })

  it('should call pull callback when reader pulls', async () => {
    const pull = vi.fn()
    const stream = new DuplexStream({ pull })

    const reader = stream.readable.getReader()

    // Push and end to complete the stream
    setTimeout(async () => {
      await writeAndClose(stream.writable, ['data'])
    })

    await reader.read()

    expect(pull).toHaveBeenCalled()
  })

  it('should abort the stream with error', async () => {
    const stream = new DuplexStream<string>()

    await writeAndAbort(stream.writable, ['hello'], new Error('Test abort'))

    const reader = stream.readable.getReader()

    await expect(reader.read()).rejects.toThrow('Test abort')
  })

  it('should abort with default error message', async () => {
    const stream = new DuplexStream<string>()

    await writeAndAbort(stream.writable, ['hello'])

    const reader = stream.readable.getReader()

    await expect(reader.read()).rejects.toThrow('Stream aborted')
  })

  it('should work with async iteration', async () => {
    const stream = new DuplexStream<number>()

    setTimeout(async () => {
      await writeAndClose(stream.writable, [1, 2, 3])
    }, 1)

    const chunks: number[] = []
    for await (const chunk of stream.readable as any) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([1, 2, 3])
  })

  it('should handle empty stream', async () => {
    const stream = new DuplexStream<string>()

    const writer = stream.writable.getWriter()
    await writer.close()
    writer.releaseLock()

    const reader = stream.readable.getReader()
    const result = await reader.read()

    expect(result.done).toBe(true)
    expect(result.value).toBeUndefined()
  })
})
