import { Readable } from 'node:stream'

import type { SendResult } from '@nmtjs/protocol/server'
import type { Mock } from 'vitest'
import {
  DEFAULT_BLOB_CHUNK_SIZE,
  ProtocolBlob,
  STREAM_FLOW_CONTROL_VIOLATION_REASON,
} from '@nmtjs/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BlobStreamsManager,
  STREAM_IDLE_TIMEOUT_REASON,
  STREAM_TRANSPORT_DROP_REASON,
} from '../../../src/neemata/ws/streams.ts'

const IDLE_TIMEOUT = 5000
const CLIENT_STREAM_WINDOW = { capacity: 100, refill: 50 }

// stream data flows on nextTick ('readable' emission), which fake timers do
// not intercept
const flush = () => new Promise<void>((resolve) => process.nextTick(resolve))

type TestSink = {
  chunks: Buffer[]
  ended: boolean
  errors: Error[]
  sendResult: SendResult
  sink: {
    chunk: Mock<(chunk: Buffer) => SendResult>
    end: Mock<() => void>
    error: Mock<(error: Error) => void>
  }
}

const createTestSink = (): TestSink => {
  const state: TestSink = {
    chunks: [],
    ended: false,
    errors: [],
    sendResult: 'delivered',
    sink: {
      chunk: vi.fn((chunk: Buffer): SendResult => {
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
    manager = new BlobStreamsManager({
      idleTimeout: IDLE_TIMEOUT,
      clientStreamWindow: CLIENT_STREAM_WINDOW,
    })
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

        expect(manager.requestClientStreamCredit('conn-1', 100)).toBe(100)
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

        manager.requestClientStreamCredit('conn-1', 100)
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(99)),
        ).toBe(true)
        // 1 byte of credit left
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(2)),
        ).toBe(false)
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(1)),
        ).toBe(true)
      })

      it('refills a large accepted frame from one demand signal', () => {
        manager.createClientStream('conn-1', 1, 100, { type: 'text/plain' }, {})

        expect(manager.requestClientStreamCredit('conn-1', 100)).toBe(100)
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(100)),
        ).toBe(true)
        expect(manager.requestClientStreamCredit('conn-1', 100)).toBe(100)
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(100)),
        ).toBe(true)
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(1)),
        ).toBe(false)
      })

      it('rejects zero-byte pushes as violations', () => {
        manager.createClientStream('conn-1', 1, 100, { type: 'text/plain' }, {})
        manager.requestClientStreamCredit('conn-1', 100)
        // an empty push consumes no credit but would refresh the idle timer
        expect(
          manager.pushToClientStream('conn-1', 100, new Uint8Array(0)),
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

      it('notifies the peer at most once, with the abort reason', () => {
        const notify = vi.fn()
        manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
          notify,
        )

        manager.abortClientStream(
          'conn-1',
          100,
          STREAM_FLOW_CONTROL_VIOLATION_REASON,
        )
        manager.abortClientStream('conn-1', 100, 'again')

        expect(notify).toHaveBeenCalledTimes(1)
        expect(notify).toHaveBeenCalledWith(
          STREAM_FLOW_CONTROL_VIOLATION_REASON,
        )
      })

      it('does not echo peer-originated aborts back', () => {
        const notify = vi.fn()
        manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
          notify,
        )

        manager.abortClientStream('conn-1', 100, 'client cancelled', false)

        expect(notify).not.toHaveBeenCalled()
        expect(manager.clientStreams.size).toBe(0)
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
        manager.requestClientStreamCredit('conn-1', 100)
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

      it('resets when the consumer is active before a refill is due', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const destroySpy = vi.spyOn(stream, 'destroy')

        manager.requestClientStreamCredit('conn-1', 100)
        manager.pushToClientStream('conn-1', 100, new Uint8Array(10))
        vi.advanceTimersByTime(IDLE_TIMEOUT - 1000)

        expect(manager.requestClientStreamCredit('conn-1', 100)).toBe(0)
        vi.advanceTimersByTime(IDLE_TIMEOUT - 1000)
        expect(destroySpy).not.toHaveBeenCalled()

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

      it('does not emit zero-byte source chunks', async () => {
        const test = createTestSink()
        const source = new Readable({
          read() {
            this.push(Buffer.alloc(0))
            this.push(Buffer.from('abc'))
            this.push(null)
          },
        })
        manager.createServerStream(
          'conn-1',
          1,
          100,
          new ProtocolBlob({ source, type: 'text/plain' }),
          test.sink,
        )

        manager.pullServerStream('conn-1', 100, 3)
        await flush()
        await flush()

        expect(test.chunks).toEqual([Buffer.from('abc')])
        expect(test.sink.end).toHaveBeenCalledTimes(1)
      })

      it('keeps a 64 KiB source chunk in one frame', async () => {
        const test = createTestSink()
        manager.createServerStream(
          'conn-1',
          1,
          100,
          blobFromBytes(Buffer.alloc(DEFAULT_BLOB_CHUNK_SIZE)),
          test.sink,
        )

        manager.pullServerStream('conn-1', 100, DEFAULT_BLOB_CHUNK_SIZE)
        await flush()
        await flush()

        expect(test.chunks).toHaveLength(1)
        expect(test.chunks[0].byteLength).toBe(DEFAULT_BLOB_CHUNK_SIZE)
      })

      it('should do nothing for non-existent stream', () => {
        expect(() => manager.pullServerStream('conn-1', 999, 10)).not.toThrow()
      })
    })

    describe('transport drop', () => {
      it('aborts the stream and cleans up local state on a dropped frame', async () => {
        const test = createTestSink()
        test.sendResult = 'dropped'
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
      it('propagates a source error through the sink once granted', async () => {
        const test = createTestSink()
        const source = new Readable({ read() {} })
        manager.createServerStream(
          'conn-1',
          1,
          100,
          new ProtocolBlob({ source, type: 'text/plain' }),
          test.sink,
        )

        manager.pullServerStream('conn-1', 100, 10)
        source.destroy(new Error('source blew up'))
        await flush()

        expect(test.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'source blew up' }),
        )
        expect(manager.serverStreams.size).toBe(0)
      })

      it('holds a pre-grant source error until the first grant', async () => {
        const test = createTestSink()
        const source = new Readable({ read() {} })
        manager.createServerStream(
          'conn-1',
          1,
          100,
          new ProtocolBlob({ source, type: 'text/plain' }),
          test.sink,
        )

        // source blows up before any grant: the abort frame must not be able
        // to overtake the RpcResponse referencing this stream
        source.destroy(new Error('early failure'))
        await flush()
        await flush()

        expect(test.sink.error).not.toHaveBeenCalled()
        // the stream stays registered so the client's pull still lands
        expect(manager.serverStreams.size).toBe(1)

        manager.pullServerStream('conn-1', 100, 10)
        await flush()

        expect(test.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'early failure' }),
        )
        expect(manager.serverStreams.size).toBe(0)
      })
    })

    describe('credit overflow', () => {
      it('aborts the stream when grants exceed the credit cap', () => {
        const test = createTestSink()
        const source = new Readable({ read() {} })
        manager.createServerStream(
          'conn-1',
          1,
          100,
          new ProtocolBlob({ source, type: 'text/plain' }),
          test.sink,
        )

        manager.pullServerStream('conn-1', 100, 2 ** 32 - 1)
        expect(test.sink.error).not.toHaveBeenCalled()

        manager.pullServerStream('conn-1', 100, 1)

        expect(test.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({
            message: STREAM_FLOW_CONTROL_VIOLATION_REASON,
          }),
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

      it('allows time to consume every chunk sent in a credit batch', async () => {
        const test = createTestSink()
        const source = new Readable({ read() {} })
        manager.createServerStream(
          'conn-1',
          1,
          100,
          new ProtocolBlob({ source, type: 'text/plain' }),
          test.sink,
        )

        manager.pullServerStream('conn-1', 100, 4 * DEFAULT_BLOB_CHUNK_SIZE)
        source.push(Buffer.alloc(4 * DEFAULT_BLOB_CHUNK_SIZE))
        await flush()

        expect(test.chunks).toHaveLength(4)
        vi.advanceTimersByTime(4 * IDLE_TIMEOUT - 1)
        expect(test.sink.error).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        expect(test.sink.error).toHaveBeenCalledWith(
          expect.objectContaining({ message: STREAM_IDLE_TIMEOUT_REASON }),
        )
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

        // teardown must not fire peer notifications into a dying transport
        expect(test1.sink.error).not.toHaveBeenCalled()
        expect(test2.sink.error).not.toHaveBeenCalled()
        expect(test3.sink.error).not.toHaveBeenCalled()
        expect(manager.serverStreams.size).toBe(1)
        expect(manager.serverStreams.keys().next().value).toBe('conn-2:100')
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
        expect(manager.serverStreams.size).toBe(0)
        expect(manager.clientStreams.size).toBe(0)
      })

      it('should do nothing for non-existent connection', () => {
        expect(() => manager.cleanupConnection('non-existent')).not.toThrow()
      })
    })
  })

  describe('Custom idle timeout', () => {
    it('uses the configured duration', () => {
      const customManager = new BlobStreamsManager({
        idleTimeout: 1000,
        clientStreamWindow: CLIENT_STREAM_WINDOW,
      })

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
