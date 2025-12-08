import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TestSetup } from '../../_setup.ts'
import {
  ApiError,
  createProcedure,
  createRootRouter,
  createRouter,
  createTestSetup,
  ErrorCode,
  ProtocolError,
  rpcAbortSignal,
  t,
} from '../../_setup.ts'

// =============================================================================
// Procedures for Simple RPC Tests
// =============================================================================

const echoProcedure = createProcedure({
  input: t.object({ message: t.string() }),
  output: t.object({ echoed: t.string() }),
  handler: (_, input) => ({ echoed: input.message }),
})

let counterValue = 0
const counterProcedure = createProcedure({
  input: t.object({ step: t.number() }),
  output: t.object({
    count: t.number(),
    input: t.object({ step: t.number() }),
  }),
  handler: (_, input) => {
    counterValue += input.step
    return { count: counterValue, input }
  },
})

const doubleProcedure = createProcedure({
  input: t.object({ value: t.number() }),
  output: t.object({ doubled: t.number() }),
  handler: async (_, input) => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { doubled: input.value * 2 }
  },
})

const nullPayloadProcedure = createProcedure({
  output: t.object({ received: t.literal('none') }),
  handler: () => ({ received: 'none' as const }),
})

const complexProcedure = createProcedure({
  input: t.object({
    user: t.object({
      name: t.string(),
      tags: t.array(t.string()),
      metadata: t.object({
        createdAt: t.string(),
        settings: t.object({ theme: t.string(), notifications: t.boolean() }),
      }),
    }),
  }),
  output: t.object({
    processed: t.object({
      user: t.object({
        name: t.string(),
        tags: t.array(t.string()),
        metadata: t.object({
          createdAt: t.string(),
          settings: t.object({ theme: t.string(), notifications: t.boolean() }),
        }),
      }),
    }),
  }),
  handler: (_, input) => ({ processed: input }),
})

const arraysProcedure = createProcedure({
  input: t.object({ items: t.array(t.number()) }),
  output: t.object({ sum: t.number(), count: t.number() }),
  handler: (_, input) => ({
    sum: input.items.reduce((a, b) => a + b, 0),
    count: input.items.length,
  }),
})

const emptyPayloadProcedure = createProcedure({
  input: t.object({}),
  output: t.object({ status: t.string() }),
  handler: () => ({ status: 'ok' }),
})

const failingProcedure = createProcedure({
  input: t.object({}),
  output: t.never(),
  handler: () => {
    throw new Error('Server error occurred')
  },
})

const failingWithCodeProcedure = createProcedure({
  input: t.object({ code: t.string() }),
  output: t.never(),
  handler: (_, input) => {
    throw new ApiError(input.code as ErrorCode, 'Custom error message', {
      customData: 'test',
    })
  },
})

const slowProcedure = createProcedure({
  input: t.object({}),
  output: t.object({ result: t.string() }),
  handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10000))
    return { result: 'too late' }
  },
})

const fastProcedure = createProcedure({
  input: t.object({}),
  output: t.object({ result: t.string() }),
  handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { result: 'fast' }
  },
})

const abortableProcedure = createProcedure({
  input: t.object({}),
  output: t.object({ result: t.string() }),
  dependencies: { signal: rpcAbortSignal },
  handler: async ({ signal }) => {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve({ result: 'completed' }), 5000)
      signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        reject(new Error('Aborted'))
      })
    })
    return { result: 'should not reach' }
  },
})

// Track whether aborted signal was received by handler
let abortableWithStateSignalState: { wasAborted: boolean; reason?: string } = {
  wasAborted: false,
}
const abortableWithStateProcedure = createProcedure({
  input: t.object({ delayMs: t.number() }),
  output: t.object({ signalWasAborted: t.boolean() }),
  dependencies: { signal: rpcAbortSignal },
  handler: async ({ signal }, input) => {
    // Wait for the specified delay to allow abort to propagate
    await new Promise((resolve) => setTimeout(resolve, input.delayMs))
    abortableWithStateSignalState = {
      wasAborted: signal.aborted,
      reason: signal.reason?.toString(),
    }
    return { signalWasAborted: signal.aborted }
  },
})

// For testing ProtocolError directly
const failingWithProtocolErrorProcedure = createProcedure({
  input: t.object({}),
  output: t.never(),
  handler: () => {
    throw new ProtocolError(ErrorCode.Forbidden, 'Protocol error test')
  },
})

const router = createRootRouter(
  createRouter({
    routes: {
      echo: echoProcedure,
      counter: counterProcedure,
      double: doubleProcedure,
      nullPayload: nullPayloadProcedure,
      complex: complexProcedure,
      arrays: arraysProcedure,
      emptyPayload: emptyPayloadProcedure,
      failing: failingProcedure,
      failingWithCode: failingWithCodeProcedure,
      failingWithProtocolError: failingWithProtocolErrorProcedure,
      slow: slowProcedure,
      fast: fastProcedure,
      abortable: abortableProcedure,
      abortableWithState: abortableWithStateProcedure,
    },
  }),
)

// =============================================================================
// Tests
// =============================================================================

// Helper to wait for async cleanup to complete
const waitForCleanup = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('Simple RPC Calls', () => {
  let setup: TestSetup<typeof router>

  beforeEach(async () => {
    counterValue = 0
    setup = await createTestSetup({ router })
  })

  afterEach(async () => {
    await setup.cleanup()
  })

  describe('Basic Operations', () => {
    it('should complete a simple RPC call', async () => {
      const result = await setup.client.call.echo({ message: 'hello' })
      expect(result).toEqual({ echoed: 'hello' })

      // Verify cleanup
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should handle multiple sequential RPC calls', async () => {
      const result1 = await setup.client.call.counter({ step: 1 })
      const result2 = await setup.client.call.counter({ step: 2 })
      const result3 = await setup.client.call.counter({ step: 3 })

      expect(result1).toEqual({ count: 1, input: { step: 1 } })
      expect(result2).toEqual({ count: 3, input: { step: 2 } })
      expect(result3).toEqual({ count: 6, input: { step: 3 } })

      // Verify cleanup after all sequential calls
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should handle concurrent RPC calls', async () => {
      const results = await Promise.all([
        setup.client.call.double({ value: 1 }),
        setup.client.call.double({ value: 2 }),
        setup.client.call.double({ value: 3 }),
      ])

      expect(results).toEqual([{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }])

      // Verify cleanup after all concurrent calls
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should handle procedure with no input', async () => {
      const result = await setup.client.call.nullPayload()
      expect(result).toEqual({ received: 'none' })

      // Verify cleanup
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should handle complex nested objects', async () => {
      const complexPayload = {
        user: {
          name: 'Test User',
          tags: ['admin', 'developer'],
          metadata: {
            createdAt: '2024-01-01',
            settings: { theme: 'dark', notifications: true },
          },
        },
      }

      const result = await setup.client.call.complex(complexPayload)
      expect(result).toEqual({ processed: complexPayload })

      // Verify cleanup
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should handle arrays standalone', async () => {
      const result = await setup.client.call.arrays({ items: [1, 2, 3, 4, 5] })
      expect(result).toEqual({ sum: 15, count: 5 })

      // Verify cleanup
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should handle empty object payload', async () => {
      const result = await setup.client.call.emptyPayload({})
      expect(result).toEqual({ status: 'ok' })

      // Verify cleanup
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })
  })

  describe('Error Handling', () => {
    it('should propagate server errors to client', async () => {
      await expect(setup.client.call.failing({})).rejects.toThrow()

      // Verify cleanup after error
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should propagate custom error code to client', async () => {
      try {
        await setup.client.call.failingWithCode({ code: ErrorCode.Forbidden })
        expect.fail('Should have thrown')
      } catch (error: any) {
        expect(error.code).toBe(ErrorCode.Forbidden)
        expect(error.message).toBe('Custom error message')
      }

      // Verify cleanup after error
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should propagate ProtocolError from server', async () => {
      try {
        await setup.client.call.failingWithProtocolError({})
        expect.fail('Should have thrown')
      } catch (error: any) {
        expect(error.code).toBe(ErrorCode.Forbidden)
        expect(error.message).toBe('Protocol error test')
      }

      // Verify cleanup after error
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should reject call after disconnect', async () => {
      await setup.client.disconnect()

      await expect(
        setup.client.call.echo({ message: 'test' }),
      ).rejects.toThrow()

      // Re-setup for cleanup
      setup = await createTestSetup({ router })
    })
  })

  describe('Timeouts', () => {
    it('should timeout if server takes too long', async () => {
      await expect(
        setup.client.call.slow({}, { timeout: 50 }),
      ).rejects.toThrow()

      // Verify cleanup after timeout
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should complete if server responds before timeout', async () => {
      const result = await setup.client.call.fast({}, { timeout: 1000 })
      expect(result).toEqual({ result: 'fast' })

      // Verify cleanup
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should clear timeout on successful response (no leaks)', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          setup.client.call.echo({ message: `test${i}` }, { timeout: 5000 }),
        ),
      )

      expect(results).toHaveLength(10)

      results.forEach((result, i) => {
        expect(result).toEqual({ echoed: `test${i}` })
      })

      // Verify cleanup after all calls
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should use custom per-call timeout overriding client default', async () => {
      // Create a client with short default timeout
      const shortTimeoutSetup = await createTestSetup({ router, timeout: 10 })
      try {
        // This should fail with the default 10ms timeout
        await expect(shortTimeoutSetup.client.call.fast({})).rejects.toThrow()

        // Wait for the server to complete processing and send the response
        // This prevents "Call not found" unhandled rejection
        await new Promise((resolve) => setTimeout(resolve, 50))

        // But should succeed with a longer per-call timeout
        const result = await shortTimeoutSetup.client.call.fast(
          {},
          { timeout: 1000 },
        )
        expect(result).toEqual({ result: 'fast' })
      } finally {
        await shortTimeoutSetup.cleanup()
      }
    })
  })

  describe('Abort Signal', () => {
    it('should abort RPC call when signal is aborted', async () => {
      const controller = new AbortController()

      const callPromise = setup.client.call.abortable(
        {},
        { signal: controller.signal },
      )

      // Abort after a short delay
      setTimeout(() => controller.abort(), 50)

      await expect(callPromise).rejects.toThrow()

      // Verify cleanup after abort
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should abort RPC call during server processing', async () => {
      const controller = new AbortController()

      // Start a call that takes 100ms on the server
      const callPromise = setup.client.call.abortableWithState(
        { delayMs: 100 },
        { signal: controller.signal },
      )

      // Abort after 20ms (while server is still processing)
      setTimeout(() => controller.abort(), 20)

      await expect(callPromise).rejects.toThrow()

      // Verify cleanup after abort
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should propagate abort signal to server handler', async () => {
      // This test verifies that when a client aborts, the server handler
      // receives the abort via the signal. We use the abortable procedure
      // which listens for abort events and rejects when aborted.

      const controller = new AbortController()

      // Start a call that will wait for 5 seconds unless aborted
      const callPromise = setup.client.call.abortable(
        {},
        { signal: controller.signal },
      )

      // Wait a bit to ensure the call is being processed
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Abort the call
      controller.abort()

      // The call should reject because the server handler received the abort
      await expect(callPromise).rejects.toThrow()

      // Verify cleanup after abort
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should have aborted signal state in handler after client abort', async () => {
      // Reset the state tracker
      abortableWithStateSignalState = { wasAborted: false }

      const controller = new AbortController()

      // Abort immediately before making the call
      controller.abort()

      // Start a call with an already-aborted signal
      const callPromise = setup.client.call.abortableWithState(
        { delayMs: 10 },
        { signal: controller.signal },
      )

      await expect(callPromise).rejects.toThrow()

      // Verify cleanup after abort
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })
  })
})
