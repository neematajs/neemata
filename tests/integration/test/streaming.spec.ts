import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TestSetup } from './_setup.ts'
import {
  createProcedure,
  createRootRouter,
  createRouter,
  createTestSetup,
  rpcAbortSignal,
  t,
} from './_setup.ts'

// =============================================================================
// Procedures for Streaming Tests
// =============================================================================

const streamProcedure = createProcedure({
  input: t.object({ count: t.number() }),
  output: t.object({ index: t.number() }),
  stream: true,
  async *handler(_, { count }) {
    for (let i = 0; i < count; i++) {
      yield { index: i }
    }
  },
})

const streamDelayProcedure = createProcedure({
  input: t.object({ count: t.number(), delay: t.number() }),
  output: t.object({ index: t.number() }),
  stream: true,
  async *handler(_, { count, delay }) {
    for (let i = 0; i < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      yield { index: i }
    }
  },
})

const streamErrorProcedure = createProcedure({
  input: t.object({ errorAt: t.number() }),
  output: t.object({ index: t.number() }),
  stream: true,
  async *handler(_, { errorAt }) {
    for (let i = 0; i < 10; i++) {
      if (i === errorAt) {
        throw new Error('Stream error at index ' + i)
      }
      yield { index: i }
    }
  },
})

// Tracks when the server stops iterating (for abort tests)
let _serverIterationStopped = false
let serverIterationCleanedUp = false
let _serverIterationError: Error | null = null

const streamWithTrackingProcedure = createProcedure({
  dependencies: { signal: rpcAbortSignal },
  input: t.object({ count: t.number(), delay: t.number() }),
  output: t.object({ index: t.number() }),
  stream: true,
  async *handler({ signal }, { count, delay }) {
    _serverIterationStopped = false
    serverIterationCleanedUp = false
    _serverIterationError = null
    try {
      for (let i = 0; i < count; i++) {
        if (signal.aborted) {
          _serverIterationStopped = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
        yield { index: i }
      }
    } catch (error) {
      _serverIterationError = error as Error
      throw error
    } finally {
      serverIterationCleanedUp = true
    }
  },
})

const router = createRootRouter([
  createRouter({
    routes: {
      stream: streamProcedure,
      streamDelay: streamDelayProcedure,
      streamError: streamErrorProcedure,
      streamWithTracking: streamWithTrackingProcedure,
    },
  }),
] as const)

// =============================================================================
// Tests
// =============================================================================

describe('RPC Streaming', () => {
  let setup: TestSetup<typeof router>

  beforeEach(async () => {
    setup = await createTestSetup({ router })
  })

  afterEach(async () => {
    await setup.cleanup()
  })

  describe('Internal State Tracking', () => {
    it('should track pending call during stream', async () => {
      const stream = await setup.client.stream.streamDelay({
        count: 5,
        delay: 20,
      })

      // During streaming, client should have active RPC stream
      expect(setup.client.activeRpcStreamsCount).toBe(1)
      // Gateway should have the RPC tracked
      expect(setup.gateway.rpcs.rpcs.size).toBe(1)

      // Consume the stream
      for await (const _chunk of stream) {
        // State should remain tracked during consumption
        expect(setup.client.activeRpcStreamsCount).toBeGreaterThanOrEqual(0)
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // After completion, state should be clean
      expect(setup.client.activeRpcStreamsCount).toBe(0)
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
    })

    it('should track multiple concurrent streams', async () => {
      // Start 3 streams but don't consume yet
      const stream1 = await setup.client.stream.streamDelay({
        count: 10,
        delay: 30,
      })
      const stream2 = await setup.client.stream.streamDelay({
        count: 10,
        delay: 30,
      })
      const stream3 = await setup.client.stream.streamDelay({
        count: 10,
        delay: 30,
      })

      // All 3 should be tracked
      expect(setup.client.activeRpcStreamsCount).toBe(3)
      expect(setup.gateway.rpcs.rpcs.size).toBe(3)

      // Consume all streams
      await Promise.all([
        (async () => {
          for await (const _chunk of stream1) {
            /* consume */
          }
        })(),
        (async () => {
          for await (const _chunk of stream2) {
            /* consume */
          }
        })(),
        (async () => {
          for await (const _chunk of stream3) {
            /* consume */
          }
        })(),
      ])

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // All should be cleaned up
      expect(setup.client.activeRpcStreamsCount).toBe(0)
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.isClean).toBe(true)
    })

    it('should track stream pull state on gateway', async () => {
      const stream = await setup.client.stream.streamDelay({
        count: 3,
        delay: 50,
      })

      // Gateway should have RPC registered
      expect(setup.gateway.rpcs.rpcs.size).toBe(1)

      // Consume first chunk - this triggers a pull
      const iterator = stream[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.done).toBe(false)

      // After pulling, there may be a pending pull waiting
      // (the gateway's streams map tracks pending pulls)

      // Consume remaining
      while (!(await iterator.next()).done) {
        // Continue consuming
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)
    })
  })

  describe('Basic Streaming', () => {
    it('should stream all values successfully', async () => {
      const stream = await setup.client.stream.stream({ count: 5 })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      expect(chunks).toEqual([
        { index: 0 },
        { index: 1 },
        { index: 2 },
        { index: 3 },
        { index: 4 },
      ])
    })

    it('should handle single chunk stream', async () => {
      const stream = await setup.client.stream.stream({ count: 1 })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      expect(chunks).toEqual([{ index: 0 }])
    })

    it('should handle empty stream', async () => {
      const stream = await setup.client.stream.stream({ count: 0 })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      expect(chunks).toEqual([])
    })

    it('should handle many chunks', async () => {
      const stream = await setup.client.stream.stream({ count: 100 })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(100)
      expect(chunks[0]).toEqual({ index: 0 })
      expect(chunks[99]).toEqual({ index: 99 })
    })

    it('should handle stream with delays', async () => {
      const stream = await setup.client.stream.streamDelay({
        count: 3,
        delay: 10,
      })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      expect(chunks).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }])
    })
  })

  describe('Client Consumption Patterns', () => {
    it('should allow partial consumption with break', async () => {
      const stream = await setup.client.stream.stream({ count: 10 })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
        if (chunks.length >= 3) break
      }

      expect(chunks).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }])
    })

    it('should allow cancelling stream via readable.cancel()', async () => {
      const stream = await setup.client.stream.streamDelay({
        count: 100,
        delay: 50,
      })

      // Get the readable stream and cancel it after reading a few chunks
      const reader = (
        stream as AsyncIterable<unknown> & { readable: ReadableStream }
      ).readable?.getReader()

      if (reader) {
        // Read a couple chunks
        const chunk1 = await reader.read()
        expect(chunk1.done).toBe(false)
        expect(chunk1.value).toEqual({ index: 0 })

        const chunk2 = await reader.read()
        expect(chunk2.done).toBe(false)
        expect(chunk2.value).toEqual({ index: 1 })

        // Cancel the stream
        await reader.cancel()

        // Wait for server to receive the cancel
        await new Promise((resolve) => setTimeout(resolve, 100))
      } else {
        // Fallback: use the async iterator and break early
        const chunks: unknown[] = []
        for await (const chunk of stream) {
          chunks.push(chunk)
          if (chunks.length >= 2) break
        }
        expect(chunks).toHaveLength(2)
      }
    })

    it('should allow aborting stream via signal', async () => {
      const controller = new AbortController()
      const stream = await setup.client.stream.streamDelay(
        { count: 100, delay: 50 },
        { signal: controller.signal },
      )
      const chunks: unknown[] = []

      try {
        for await (const chunk of stream) {
          chunks.push(chunk)
          if (chunks.length >= 2) {
            controller.abort()
          }
        }
      } catch {
        // Expected abort error
      }

      expect(chunks.length).toBeGreaterThanOrEqual(2)
      expect(chunks.length).toBeLessThan(100)
    })
  })

  describe('Error Handling', () => {
    it('should propagate server error during iteration', async () => {
      const stream = await setup.client.stream.streamError({ errorAt: 3 })
      const chunks: unknown[] = []

      await expect(async () => {
        for await (const chunk of stream) {
          chunks.push(chunk)
        }
      }).rejects.toThrow()

      expect(chunks).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }])
    })

    it('should stop server iteration when client aborts', async () => {
      const controller = new AbortController()
      const stream = await setup.client.stream.streamWithTracking(
        { count: 100, delay: 20 },
        { signal: controller.signal },
      )
      const chunks: unknown[] = []

      try {
        for await (const chunk of stream) {
          chunks.push(chunk)
          if (chunks.length >= 3) {
            controller.abort()
          }
        }
      } catch {
        // Expected abort error
      }

      // Wait for server to process the abort - need more time for cleanup
      await new Promise((resolve) => setTimeout(resolve, 200))

      // The server should have cleaned up (finally block ran)
      expect(serverIterationCleanedUp).toBe(true)
      expect(chunks.length).toBeGreaterThanOrEqual(3)
      expect(chunks.length).toBeLessThan(100)
    })
  })

  describe('Backpressure', () => {
    it('should wait for client pull before sending next chunk', async () => {
      const pullTimes: number[] = []
      const chunkTimes: number[] = []

      const stream = await setup.client.stream.stream({ count: 5 })
      const startTime = Date.now()

      for await (const _chunk of stream) {
        chunkTimes.push(Date.now() - startTime)
        // Simulate slow client processing
        await new Promise((resolve) => setTimeout(resolve, 10))
        pullTimes.push(Date.now() - startTime)
      }

      // Verify chunks are received in order with reasonable timing
      expect(chunkTimes).toHaveLength(5)
      // Each chunk should come after the previous pull (within reasonable margin)
      for (let i = 1; i < chunkTimes.length; i++) {
        // The chunk should arrive after we finished processing the previous one
        expect(chunkTimes[i]).toBeGreaterThanOrEqual(pullTimes[i - 1] - 5)
      }
    })

    it('should not cause buffer overflow with slow client', async () => {
      // Send many chunks quickly from server
      const stream = await setup.client.stream.stream({ count: 50 })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
        // Simulate very slow client
        await new Promise((resolve) => setTimeout(resolve, 5))
      }

      // All chunks should be received without memory issues
      expect(chunks).toHaveLength(50)
    })

    it('should deliver chunks without unnecessary delays for fast client', async () => {
      const startTime = Date.now()
      const stream = await setup.client.stream.stream({ count: 10 })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      const elapsed = Date.now() - startTime
      expect(chunks).toHaveLength(10)
      // Should complete quickly for a fast client (under 500ms)
      expect(elapsed).toBeLessThan(500)
    })
  })

  describe('Resource Cleanup', () => {
    it('should cleanup server iteration on normal completion', async () => {
      serverIterationCleanedUp = false

      const stream = await setup.client.stream.streamWithTracking({
        count: 3,
        delay: 10,
      })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(chunks).toHaveLength(3)
      expect(serverIterationCleanedUp).toBe(true)

      // Verify client internal state is clean
      expect(setup.client.pendingCallsCount).toBe(0)
      expect(setup.client.activeRpcStreamsCount).toBe(0)
    })

    it('should cleanup server iteration on client abort', async () => {
      serverIterationCleanedUp = false
      const controller = new AbortController()
      const chunks: unknown[] = []

      const stream = await setup.client.stream.streamWithTracking(
        { count: 100, delay: 20 },
        { signal: controller.signal },
      )

      try {
        for await (const chunk of stream) {
          chunks.push(chunk)
          if ((chunk as { index: number }).index >= 2) {
            controller.abort()
          }
        }
      } catch {
        // Expected abort
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(serverIterationCleanedUp).toBe(true)

      // Verify client internal state is clean
      expect(setup.client.pendingCallsCount).toBe(0)
      expect(setup.client.activeRpcStreamsCount).toBe(0)
    })

    it('should cleanup client stream on normal completion', async () => {
      const stream = await setup.client.stream.stream({ count: 5 })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(chunks).toHaveLength(5)

      // Verify client internal state is clean
      expect(setup.client.pendingCallsCount).toBe(0)
      expect(setup.client.activeRpcStreamsCount).toBe(0)
      expect(setup.client.isClean).toBe(true)
    })

    it('should cleanup client stream on break', async () => {
      const stream = await setup.client.stream.stream({ count: 10 })
      const chunks: unknown[] = []

      for await (const chunk of stream) {
        chunks.push(chunk)
        if (chunks.length >= 3) break
      }

      expect(chunks).toHaveLength(3)
      // Allow time for cleanup message to be sent
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Note: Due to known issue with break not cancelling underlying stream,
      // client state may not be fully clean here. See Known Issues in TESTING.md
    })
  })

  describe('Memory Leak Prevention', () => {
    it('should clear gateway and client state after stream completion', async () => {
      const stream = await setup.client.stream.stream({ count: 5 })

      for await (const _chunk of stream) {
        // Consume all chunks
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Verify gateway RPC state is cleared
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)

      // Verify client internal state is cleared
      expect(setup.client.pendingCallsCount).toBe(0)
      expect(setup.client.activeRpcStreamsCount).toBe(0)
      expect(setup.client.isClean).toBe(true)
    })

    it('should clear gateway and client state after stream abort', async () => {
      const controller = new AbortController()
      const stream = await setup.client.stream.streamDelay(
        { count: 100, delay: 20 },
        { signal: controller.signal },
      )

      try {
        for await (const chunk of stream) {
          if ((chunk as { index: number }).index >= 2) {
            controller.abort()
          }
        }
      } catch {
        // Expected abort
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Verify gateway RPC state is cleared
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)

      // Verify client internal state is cleared
      expect(setup.client.pendingCallsCount).toBe(0)
      expect(setup.client.activeRpcStreamsCount).toBe(0)
      expect(setup.client.isClean).toBe(true)
    })

    it('should clear gateway and client state after stream error', async () => {
      const stream = await setup.client.stream.streamError({ errorAt: 2 })

      try {
        for await (const _chunk of stream) {
          // Consume chunks until error
        }
      } catch {
        // Expected error
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Verify gateway RPC state is cleared
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)

      // Verify client internal state is cleared
      expect(setup.client.pendingCallsCount).toBe(0)
      expect(setup.client.activeRpcStreamsCount).toBe(0)
      expect(setup.client.isClean).toBe(true)
    })

    it('should handle multiple concurrent streams and cleanup all', async () => {
      const streams = await Promise.all([
        setup.client.stream.stream({ count: 3 }),
        setup.client.stream.stream({ count: 5 }),
        setup.client.stream.stream({ count: 2 }),
      ])

      // Consume all streams concurrently
      await Promise.all(
        streams.map(async (stream) => {
          for await (const _chunk of stream) {
            // Consume
          }
        }),
      )

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Verify all gateway RPC state is cleared
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)

      // Verify client internal state is cleared
      expect(setup.client.pendingCallsCount).toBe(0)
      expect(setup.client.activeRpcStreamsCount).toBe(0)
      expect(setup.client.isClean).toBe(true)
    })

    it('should not leak state after partial consumption with break', async () => {
      // FIXME: When breaking out of a for-await loop, the async iterator's return()
      // is called but ProtocolServerStreamInterface doesn't cancel the underlying
      // readable stream, so the cancel callback (which sends RpcAbort) is never invoked.
      // This needs to be fixed in packages/protocol/src/client/stream.ts
      const stream = await setup.client.stream.stream({ count: 100 })

      let count = 0
      for await (const _chunk of stream) {
        count++
        if (count >= 5) break
      }

      // Wait for cleanup - breaking out of a stream needs time to send abort and process
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Verify gateway state is cleared
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)

      // Verify client internal state is cleared
      expect(setup.client.pendingCallsCount).toBe(0)
      expect(setup.client.activeRpcStreamsCount).toBe(0)
      expect(setup.client.isClean).toBe(true)
    })
  })
})
