import { Readable } from 'node:stream'

import type { Mock } from 'vitest'
import { ProtocolBlob } from '@nmtjs/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BlobStreamsManager,
  STREAM_IDLE_TIMEOUT_REASON,
  STREAM_TRANSPORT_DROP_REASON,
} from '../src/streams.ts'

const IDLE_TIMEOUT = 5000

// stream data flows on nextTick ('readable' emission), which fake timers do
// not intercept
const flush = () => new Promise<void>((resolve) => process.nextTick(resolve))

type TestSink = {
  chunks: Buffer[]
  ended: boolean
  errors: Error[]
  sendResult: boolean
  sink: {
    chunk: Mock<(chunk: Buffer) => boolean>
    end: Mock<() => void>
    error: Mock<(error: Error) => void>
  }
}

const createTestSink = (): TestSink => {
  const state: TestSink = {
    chunks: [],
    ended: false,
    errors: [],
    sendResult: true,
    sink: {
      chunk: vi.fn((chunk: Buffer): boolean => {
        state.chunks.push(Buffer.from(chunk))
        return state.sendResult
      }),
      end: vi.fn((): void => {
        state.ended = true
      }),
      error: vi.fn((error: Error): void => {
        state.errors.push(error)
      }),
    },
  }
  return state
}

const blobFromBytes = (bytes: Buffer | null) =>
  new ProtocolBlob({
    source: new Readable({
      read() {
        if (bytes) this.push(bytes)
        this.push(null)
      },
    }),
    type: 'application/octet-stream',
    size: bytes?.byteLength,
  })

const receivedBytes = (sink: TestSink) => Buffer.concat(sink.chunks).byteLength

describe('BlobStreamsManager', () => {
  let manager: BlobStreamsManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new BlobStreamsManager({ idleTimeout: IDLE_TIMEOUT })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Client Streams (Upload)', () => {
    describe('createClientStream', () => {
      it('should create a client stream', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'application/octet-stream', size: 1024 },
          {},
        )

        expect(stream).toBeDefined()
        expect(stream.id).toBe(100)
        expect(stream.metadata).toEqual({
          type: 'application/octet-stream',
          size: 1024,
        })
      })

      it('should allow multiple streams per connection', () => {
        const stream1 = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const stream2 = manager.createClientStream(
          'conn-1',
          1,
          101,
          { type: 'image/png' },
          {},
        )

        expect(stream1.id).toBe(100)
        expect(stream2.id).toBe(101)
      })
    })

    describe('credit accounting', () => {
      it('accepts a push within the outstanding grant and writes it', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const writeSpy = vi.spyOn(stream, 'write')

        manager.grantClientStream('conn-1', 100, 10)
        const chunk = new Uint8Array([1, 2, 3])
        const accepted = manager.pushToClientStream('conn-1', 100, chunk)

        expect(accepted).toBe(true)
        expect(writeSpy).toHaveBeenCalledWith(chunk)
      })

      it('rejects a push with no outstanding grant', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const writeSpy = vi.spyOn(stream, 'write')

        const accepted = manager.pushToClientStream(
          'conn-1',
          100,
          new Uint8Array([1]),
        )

        expect(accepted).toBe(false)
        expect(writeSpy).not.toHaveBeenCalled()
      })

      it('rejects a push exceeding the remaining grant', () => {
        manager.createClientStream('conn-1', 1, 100, { type: 'text/plain' }, {})

        manager.grantClientStream('conn-1', 100, 4)
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(3)),
        ).toBe(true)
        // 1 byte of credit left
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(2)),
        ).toBe(false)
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(1)),
        ).toBe(true)
      })

      it('keeps leftover credit valid across grants', () => {
        manager.createClientStream('conn-1', 1, 100, { type: 'text/plain' }, {})

        manager.grantClientStream('conn-1', 100, 10)
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(4)),
        ).toBe(true)
        manager.grantClientStream('conn-1', 100, 10)
        // 6 + 10 outstanding
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(16)),
        ).toBe(true)
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(1)),
        ).toBe(false)
      })

      it('ignores pushes for non-existent streams', () => {
        expect(
          manager.pushToClientStream('conn-1', 999, new Uint8Array([1])),
        ).toBe(true)
      })
    })

    describe('endClientStream', () => {
      it('should end the stream', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )

        const endSpy = vi.spyOn(stream, 'end')

        manager.endClientStream('conn-1', 100)

        expect(endSpy).toHaveBeenCalledWith(null)
      })

      it('should remove the stream and clear the idle timer', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const destroySpy = vi.spyOn(stream, 'destroy')

        manager.endClientStream('conn-1', 100)

        vi.advanceTimersByTime(IDLE_TIMEOUT * 3)
        expect(destroySpy).not.toHaveBeenCalled()
      })

      it('should do nothing for non-existent stream', () => {
        expect(() => manager.endClientStream('conn-1', 999)).not.toThrow()
      })
    })

    describe('abortClientStream', () => {
      it('should destroy stream with error', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )

        const destroySpy = vi.spyOn(stream, 'destroy')

        manager.abortClientStream('conn-1', 100, 'Custom error')

        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Custom error' }),
        )
      })

      it('should use default error message', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )

        const destroySpy = vi.spyOn(stream, 'destroy')

        manager.abortClientStream('conn-1', 100)

        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Aborted' }),
        )
      })

      it('should do nothing for non-existent stream', () => {
        expect(() => manager.abortClientStream('conn-1', 999)).not.toThrow()
      })
    })

    describe('consumeClientStream / getClientCallStreamIds', () => {
      it('should return only still-unconsumed stream ids for a call', () => {
        manager.createClientStream('conn-1', 1, 100, { type: 'text/plain' }, {})
        manager.createClientStream('conn-1', 1, 101, { type: 'text/plain' }, {})
        manager.createClientStream('conn-1', 2, 102, { type: 'text/plain' }, {})

        manager.consumeClientStream('conn-1', 1, 100)

        expect(manager.getClientCallStreamIds('conn-1', 1)).toEqual([101])
        expect(manager.getClientCallStreamIds('conn-1', 2)).toEqual([102])
        expect(manager.getClientCallStreamIds('conn-1', 999)).toEqual([])
      })
    })

    describe('idle timeout', () => {
      it('aborts a stream with no activity', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const destroySpy = vi.spyOn(stream, 'destroy')

        vi.advanceTimersByTime(IDLE_TIMEOUT)

        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: STREAM_IDLE_TIMEOUT_REASON }),
        )
      })

      it('resets on grants and pushes', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const destroySpy = vi.spyOn(stream, 'destroy')

        // grant (outgoing activity) resets the timer
        vi.advanceTimersByTime(IDLE_TIMEOUT - 1000)
        manager.grantClientStream('conn-1', 100, 100)
        vi.advanceTimersByTime(IDLE_TIMEOUT - 1000)
        expect(destroySpy).not.toHaveBeenCalled()

        // push (incoming activity) resets the timer
        manager.pushToClientStream('conn-1', 100, new Uint8Array(1))
        vi.advanceTimersByTime(IDLE_TIMEOUT - 1000)
        expect(destroySpy).not.toHaveBeenCalled()

        // true inactivity finally aborts
        vi.advanceTimersByTime(1000)
        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: STREAM_IDLE_TIMEOUT_REASON }),
        )
      })
    })
  })

  describe('Server Streams (Download)', () => {
    describe('createServerStream', () => {
      it('should create a server stream', () => {
        const { sink } = createTestSink()
        const stream = manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.from('test data')),
          sink,
        )

        expect(stream).toBeDefined()
        expect(stream.id).toBe(100)
        expect(stream.metadata).toEqual({
          size: 9,
          type: 'application/octet-stream',
          filename: undefined,
        })
      })

      it('emits nothing before the first grant, even for an ended source', async () => {
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.from('test data')),
          test.sink,
        )

        await flush()
        await flush()

        expect(test.sink.chunk).not.toHaveBeenCalled()
        expect(test.sink.end).not.toHaveBeenCalled()
        expect(test.sink.error).not.toHaveBeenCalled()
      })
    })

    describe('pullServerStream (credits)', () => {
      it('delivers exactly the granted bytes and slices larger chunks', async () => {
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.alloc(100, 0xab)),
          test.sink,
        )

        manager.pullServerStream('conn-1', 100, 10)
        await flush()
        await flush()

        expect(receivedBytes(test)).toBe(10)
        expect(test.sink.end).not.toHaveBeenCalled()

        // remainder flows after the next grant
        manager.pullServerStream('conn-1', 100, 90)
        await flush()
        await flush()

        expect(receivedBytes(test)).toBe(100)
        expect(Buffer.concat(test.chunks)).toEqual(Buffer.alloc(100, 0xab))
        expect(test.sink.end).toHaveBeenCalledTimes(1)
      })

      it('accumulates credits from multiple grants', async () => {
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.alloc(30)),
          test.sink,
        )

        manager.pullServerStream('conn-1', 100, 5)
        manager.pullServerStream('conn-1', 100, 5)
        await flush()
        await flush()

        expect(receivedBytes(test)).toBe(10)
      })

      it('completes the stream and cleans up when the source ends', async () => {
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.from('abc')),
          test.sink,
        )

        manager.pullServerStream('conn-1', 100, 100)
        await flush()
        await flush()

        expect(Buffer.concat(test.chunks).toString()).toBe('abc')
        expect(test.sink.end).toHaveBeenCalledTimes(1)
        expect(manager.serverStreams.size).toBe(0)
        // idle timer is gone: nothing left to abort
        expect(() => vi.advanceTimersByTime(IDLE_TIMEOUT * 3)).not.toThrow()
        expect(test.sink.error).not.toHaveBeenCalled()
      })

      it('completes an empty source after the first grant', async () => {
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(null),
          test.sink,
        )

        await flush()
        expect(test.sink.end).not.toHaveBeenCalled()

        manager.pullServerStream('conn-1', 100, 10)
        await flush()

        expect(test.sink.chunk).not.toHaveBeenCalled()
        expect(test.sink.end).toHaveBeenCalledTimes(1)
      })

      it('should do nothing for non-existent stream', () => {
        expect(() => manager.pullServerStream('conn-1', 999, 10)).not.toThrow()
      })
    })

    describe('transport drop', () => {
      it('aborts the stream and cleans up local state on a dropped frame', async () => {
        const test = createTestSink()
        test.sendResult = false
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.alloc(50)),
          test.sink,
        )

        manager.pullServerStream('conn-1', 100, 50)
        await flush()
        await flush()

        expect(test.sink.chunk).toHaveBeenCalledTimes(1)
        expect(test.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: STREAM_TRANSPORT_DROP_REASON }),
        )
        expect(test.sink.end).not.toHaveBeenCalled()
        expect(manager.serverStreams.size).toBe(0)
      })
    })

    describe('abortServerStream', () => {
      it('reports the error through the sink and cleans up', () => {
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.from('abc')),
          test.sink,
        )

        manager.abortServerStream('conn-1', 100, 'Custom error')

        expect(test.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Custom error' }),
        )
        expect(manager.serverStreams.size).toBe(0)
      })

      it('should use default error message', () => {
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.from('abc')),
          test.sink,
        )

        manager.abortServerStream('conn-1', 100)

        expect(test.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Aborted' }),
        )
      })

      it('should do nothing for non-existent stream', () => {
        expect(() => manager.abortServerStream('conn-1', 999)).not.toThrow()
      })
    })

    describe('source errors', () => {
      it('propagates a source error through the sink', async () => {
        const test = createTestSink()
        const source = new Readable({ read() {} })
        manager.createServerStream(
          'conn-1',
          1,
          100,
          new ProtocolBlob({ source, type: 'text/plain' }),
          test.sink,
        )

        source.destroy(new Error('source blew up'))
        await flush()

        expect(test.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'source blew up' }),
        )
        expect(manager.serverStreams.size).toBe(0)
      })
    })

    describe('idle timeout', () => {
      it('aborts a stream that is never pulled', () => {
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.from('abc')),
          test.sink,
        )

        vi.advanceTimersByTime(IDLE_TIMEOUT)

        expect(test.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: STREAM_IDLE_TIMEOUT_REASON }),
        )
        expect(manager.serverStreams.size).toBe(0)
      })

      it('resets on pulls and on chunks sent', async () => {
        const test = createTestSink()
        // manual source: data appears long after the grant
        const source = new Readable({ read() {} })
        manager.createServerStream(
          'conn-1',
          1,
          100,
          new ProtocolBlob({ source, type: 'text/plain' }),
          test.sink,
        )

        // pull (incoming activity) resets the timer
        vi.advanceTimersByTime(IDLE_TIMEOUT - 1000)
        manager.pullServerStream('conn-1', 100, 1000)
        vi.advanceTimersByTime(IDLE_TIMEOUT - 1000)
        expect(test.sink.error).not.toHaveBeenCalled()

        // chunk sent (outgoing activity) resets the timer
        source.push(Buffer.from('x'))
        await flush()
        expect(test.sink.chunk).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(IDLE_TIMEOUT - 1000)
        expect(test.sink.error).not.toHaveBeenCalled()

        // true inactivity finally aborts
        vi.advanceTimersByTime(1000)
        expect(test.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: STREAM_IDLE_TIMEOUT_REASON }),
        )
      })
    })

    describe('getServerStreamsMetadata', () => {
      it('returns metadata for the call streams', () => {
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.from('abc')),
          test.sink,
        )

        expect(manager.getServerStreamsMetadata('conn-1', 1)).toEqual({
          100: {
            size: 3,
            type: 'application/octet-stream',
            filename: undefined,
          },
        })
        expect(manager.getServerStreamsMetadata('conn-1', 2)).toEqual({})
      })
    })
  })

  describe('Cleanup', () => {
    describe('abortClientCallStreams', () => {
      it('should abort all client streams for a call', () => {
        const stream1 = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const stream2 = manager.createClientStream(
          'conn-1',
          1,
          101,
          { type: 'text/plain' },
          {},
        )
        const stream3 = manager.createClientStream(
          'conn-1',
          2,
          102,
          { type: 'text/plain' },
          {},
        )

        const destroy1 = vi.spyOn(stream1, 'destroy')
        const destroy2 = vi.spyOn(stream2, 'destroy')
        const destroy3 = vi.spyOn(stream3, 'destroy')

        manager.abortClientCallStreams('conn-1', 1, 'Call cancelled')

        expect(destroy1).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Call cancelled' }),
        )
        expect(destroy2).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Call cancelled' }),
        )
        expect(destroy3).not.toHaveBeenCalled()
      })

      it('should use default reason', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )

        const destroySpy = vi.spyOn(stream, 'destroy')

        manager.abortClientCallStreams('conn-1', 1)

        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Call aborted' }),
        )
      })

      it('should do nothing for non-existent call', () => {
        expect(() =>
          manager.abortClientCallStreams('conn-1', 999),
        ).not.toThrow()
      })
    })

    describe('cleanupConnection', () => {
      it('should abort all client streams for connection', () => {
        const stream1 = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const stream2 = manager.createClientStream(
          'conn-1',
          2,
          101,
          { type: 'text/plain' },
          {},
        )
        const stream3 = manager.createClientStream(
          'conn-2',
          1,
          100,
          { type: 'text/plain' },
          {},
        )

        const destroy1 = vi.spyOn(stream1, 'destroy')
        const destroy2 = vi.spyOn(stream2, 'destroy')
        const destroy3 = vi.spyOn(stream3, 'destroy')

        manager.cleanupConnection('conn-1')

        expect(destroy1).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Connection closed' }),
        )
        expect(destroy2).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Connection closed' }),
        )
        expect(destroy3).not.toHaveBeenCalled()
      })

      it('should abort all server streams for connection', () => {
        const test1 = createTestSink()
        const test2 = createTestSink()
        const test3 = createTestSink()

        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(null),
          test1.sink,
        )
        manager.createServerStream(
          'conn-1',
          2,
          101,
          blobFromBytes(null),
          test2.sink,
        )
        manager.createServerStream(
          'conn-2',
          1,
          100,
          blobFromBytes(null),
          test3.sink,
        )

        manager.cleanupConnection('conn-1')

        expect(test1.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Connection closed' }),
        )
        expect(test2.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Connection closed' }),
        )
        expect(test3.sink.error).not.toHaveBeenCalled()
        expect(manager.serverStreams.size).toBe(1)
      })

      it('should handle mixed client and server streams', () => {
        const clientStream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          101,
          blobFromBytes(null),
          test.sink,
        )

        const destroyClient = vi.spyOn(clientStream, 'destroy')

        manager.cleanupConnection('conn-1')

        expect(destroyClient).toHaveBeenCalled()
        expect(test.sink.error).toHaveBeenCalled()
      })

      it('should do nothing for non-existent connection', () => {
        expect(() => manager.cleanupConnection('non-existent')).not.toThrow()
      })
    })
  })

  describe('Custom idle timeout', () => {
    it('uses the configured duration', () => {
      const customManager = new BlobStreamsManager({ idleTimeout: 1000 })

      const stream = customManager.createClientStream(
        'conn-1',
        1,
        100,
        { type: 'text/plain' },
        {},
      )

      const destroySpy = vi.spyOn(stream, 'destroy')

      vi.advanceTimersByTime(999)
      expect(destroySpy).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(destroySpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: STREAM_IDLE_TIMEOUT_REASON }),
      )
    })
  })
})
