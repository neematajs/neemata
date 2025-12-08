import { Readable } from 'node:stream'

import { ProtocolBlob } from '@nmtjs/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StreamTimeout } from '../src/enums.ts'
import { BlobStreamsManager } from '../src/streams.ts'

describe('BlobStreamsManager', () => {
  let manager: BlobStreamsManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new BlobStreamsManager()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('constructor', () => {
    it('should use default timeout durations', () => {
      const mgr = new BlobStreamsManager()
      // We can't directly check private fields, but we can verify behavior
      expect(mgr).toBeInstanceOf(BlobStreamsManager)
    })

    it('should accept custom timeout durations', () => {
      const mgr = new BlobStreamsManager({
        timeouts: {
          [StreamTimeout.Pull]: 1000,
          [StreamTimeout.Consume]: 2000,
          [StreamTimeout.Finish]: 3000,
        },
      })
      expect(mgr).toBeInstanceOf(BlobStreamsManager)
    })
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

      it('should start consume timeout on creation', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )

        const destroySpy = vi.spyOn(stream, 'destroy')

        // Default consume timeout is 5000ms
        vi.advanceTimersByTime(5000)

        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Consume timeout' }),
        )
      })
    })

    describe('pushToClientStream', () => {
      it('should write chunk to stream', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )

        const writeSpy = vi.spyOn(stream, 'write')
        const chunk = new Uint8Array([1, 2, 3])

        manager.pushToClientStream('conn-1', 100, chunk)

        expect(writeSpy).toHaveBeenCalledWith(chunk)
      })

      it('should reset consume timeout and start pull timeout', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )

        const destroySpy = vi.spyOn(stream, 'destroy')

        // Push data after 3000ms (before consume timeout)
        vi.advanceTimersByTime(3000)
        manager.pushToClientStream('conn-1', 100, new Uint8Array([1]))

        // Wait 3000ms more (would have been 6000ms total, past consume timeout)
        vi.advanceTimersByTime(3000)
        expect(destroySpy).not.toHaveBeenCalled()

        // Pull timeout should fire at 5000ms after last push
        vi.advanceTimersByTime(2000)
        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Pull timeout' }),
        )
      })

      it('should do nothing for non-existent stream', () => {
        expect(() =>
          manager.pushToClientStream('conn-1', 999, new Uint8Array([1])),
        ).not.toThrow()
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

      it('should remove the stream', () => {
        manager.createClientStream('conn-1', 1, 100, { type: 'text/plain' }, {})

        manager.endClientStream('conn-1', 100)

        // Verify by trying to push (should be no-op)
        expect(() =>
          manager.pushToClientStream('conn-1', 100, new Uint8Array([1])),
        ).not.toThrow()
      })

      it('should clear timeouts', () => {
        const stream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )

        const destroySpy = vi.spyOn(stream, 'destroy')

        manager.endClientStream('conn-1', 100)

        // Advance past all timeouts
        vi.advanceTimersByTime(15000)

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

    describe('consumeClientStream', () => {
      it('should untrack stream from call', () => {
        manager.createClientStream('conn-1', 1, 100, { type: 'text/plain' }, {})

        // Consuming should not throw
        expect(() =>
          manager.consumeClientStream('conn-1', 1, 100),
        ).not.toThrow()
      })
    })
  })

  describe('Server Streams (Download)', () => {
    const createMockBlob = () => {
      const readable = new Readable({
        read() {
          this.push(Buffer.from('test data'))
          this.push(null)
        },
      })
      return new ProtocolBlob({ source: readable, size: 9, type: 'text/plain' })
    }

    describe('createServerStream', () => {
      it('should create a server stream', () => {
        const blob = createMockBlob()
        const stream = manager.createServerStream('conn-1', 1, 100, blob)

        expect(stream).toBeDefined()
        expect(stream.id).toBe(100)
        expect(stream.metadata).toEqual({
          size: 9,
          type: 'text/plain',
          filename: undefined,
        })
      })

      it('should start paused', () => {
        const blob = createMockBlob()
        const stream = manager.createServerStream('conn-1', 1, 100, blob)

        expect(stream.isPaused()).toBe(true)
      })

      it('should start consume and finish timeouts', () => {
        const blob = createMockBlob()
        const stream = manager.createServerStream('conn-1', 1, 100, blob)

        const destroySpy = vi.spyOn(stream, 'destroy')

        // Consume timeout is 5000ms
        vi.advanceTimersByTime(5000)

        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Consume timeout' }),
        )
      })
    })

    describe('pullServerStream', () => {
      it('should resume the stream', () => {
        const blob = createMockBlob()
        const stream = manager.createServerStream('conn-1', 1, 100, blob)

        const resumeSpy = vi.spyOn(stream, 'resume')

        manager.pullServerStream('conn-1', 100)

        expect(resumeSpy).toHaveBeenCalled()
      })

      it('should reset consume timeout and start pull timeout', () => {
        const blob = createMockBlob()
        const stream = manager.createServerStream('conn-1', 1, 100, blob)

        const destroySpy = vi.spyOn(stream, 'destroy')

        // Pull after 3000ms
        vi.advanceTimersByTime(3000)
        manager.pullServerStream('conn-1', 100)

        // Wait 3000ms more
        vi.advanceTimersByTime(3000)
        expect(destroySpy).not.toHaveBeenCalled()

        // Pull timeout fires at 5000ms after pull
        vi.advanceTimersByTime(2000)
        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Pull timeout' }),
        )
      })

      it('should do nothing for non-existent stream', () => {
        expect(() => manager.pullServerStream('conn-1', 999)).not.toThrow()
      })
    })

    describe('abortServerStream', () => {
      it('should destroy stream with error', () => {
        const blob = createMockBlob()
        const stream = manager.createServerStream('conn-1', 1, 100, blob)

        const destroySpy = vi.spyOn(stream, 'destroy')

        manager.abortServerStream('conn-1', 100, 'Custom error')

        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Custom error' }),
        )
      })

      it('should use default error message', () => {
        const blob = createMockBlob()
        const stream = manager.createServerStream('conn-1', 1, 100, blob)

        const destroySpy = vi.spyOn(stream, 'destroy')

        manager.abortServerStream('conn-1', 100)

        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Aborted' }),
        )
      })

      it('should do nothing for non-existent stream', () => {
        expect(() => manager.abortServerStream('conn-1', 999)).not.toThrow()
      })
    })

    describe('finish timeout', () => {
      it('should abort stream after finish timeout', () => {
        const blob = createMockBlob()
        const stream = manager.createServerStream('conn-1', 1, 100, blob)

        const destroySpy = vi.spyOn(stream, 'destroy')

        // Keep pulling to avoid consume/pull timeouts
        for (let i = 0; i < 5; i++) {
          vi.advanceTimersByTime(2000)
          manager.pullServerStream('conn-1', 100)
        }

        // Finish timeout is 10000ms from creation
        // We've advanced 10000ms, so it should fire
        expect(destroySpy).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Finish timeout' }),
        )
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
        const blob1 = new ProtocolBlob({
          source: new Readable({
            read() {
              this.push(null)
            },
          }),
          type: 'text/plain',
        })
        const blob2 = new ProtocolBlob({
          source: new Readable({
            read() {
              this.push(null)
            },
          }),
          type: 'text/plain',
        })
        const blob3 = new ProtocolBlob({
          source: new Readable({
            read() {
              this.push(null)
            },
          }),
          type: 'text/plain',
        })

        const stream1 = manager.createServerStream('conn-1', 1, 100, blob1)
        const stream2 = manager.createServerStream('conn-1', 2, 101, blob2)
        const stream3 = manager.createServerStream('conn-2', 1, 100, blob3)

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

      it('should handle mixed client and server streams', () => {
        const clientStream = manager.createClientStream(
          'conn-1',
          1,
          100,
          { type: 'text/plain' },
          {},
        )
        const blob = new ProtocolBlob({
          source: new Readable({
            read() {
              this.push(null)
            },
          }),
          type: 'text/plain',
        })
        const serverStream = manager.createServerStream('conn-1', 1, 101, blob)

        const destroyClient = vi.spyOn(clientStream, 'destroy')
        const destroyServer = vi.spyOn(serverStream, 'destroy')

        manager.cleanupConnection('conn-1')

        expect(destroyClient).toHaveBeenCalled()
        expect(destroyServer).toHaveBeenCalled()
      })

      it('should do nothing for non-existent connection', () => {
        expect(() => manager.cleanupConnection('non-existent')).not.toThrow()
      })
    })
  })

  describe('Custom Timeouts', () => {
    it('should use custom pull timeout', () => {
      const customManager = new BlobStreamsManager({
        timeouts: { [StreamTimeout.Pull]: 1000 },
      })

      const stream = customManager.createClientStream(
        'conn-1',
        1,
        100,
        { type: 'text/plain' },
        {},
      )

      const destroySpy = vi.spyOn(stream, 'destroy')

      // Push to start pull timeout
      customManager.pushToClientStream('conn-1', 100, new Uint8Array([1]))

      vi.advanceTimersByTime(1000)

      expect(destroySpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Pull timeout' }),
      )
    })

    it('should use custom consume timeout', () => {
      const customManager = new BlobStreamsManager({
        timeouts: { [StreamTimeout.Consume]: 2000 },
      })

      const stream = customManager.createClientStream(
        'conn-1',
        1,
        100,
        { type: 'text/plain' },
        {},
      )

      const destroySpy = vi.spyOn(stream, 'destroy')

      vi.advanceTimersByTime(2000)

      expect(destroySpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Consume timeout' }),
      )
    })

    it('should use custom finish timeout', () => {
      const customManager = new BlobStreamsManager({
        timeouts: {
          [StreamTimeout.Finish]: 3000,
          [StreamTimeout.Consume]: 10000, // Set high to avoid interference
          [StreamTimeout.Pull]: 10000,
        },
      })

      const blob = new ProtocolBlob({
        source: new Readable({
          read() {
            this.push(null)
          },
        }),
        type: 'text/plain',
      })
      const stream = customManager.createServerStream('conn-1', 1, 100, blob)

      const destroySpy = vi.spyOn(stream, 'destroy')

      vi.advanceTimersByTime(3000)

      expect(destroySpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Finish timeout' }),
      )
    })
  })
})
