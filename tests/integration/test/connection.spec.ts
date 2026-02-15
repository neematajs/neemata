import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TestSetup } from './_setup.ts'
import {
  createProcedure,
  createRootRouter,
  createRouter,
  createTestSetup,
  t,
} from './_setup.ts'

// Helper to wait for async cleanup to complete
const waitForCleanup = () => new Promise((resolve) => setTimeout(resolve, 10))

// =============================================================================
// Procedures for Connection Tests
// =============================================================================

const echoProcedure = createProcedure({
  input: t.object({ message: t.string() }),
  output: t.object({ echoed: t.string() }),
  handler: (_, input) => ({ echoed: input.message }),
})

const slowProcedure = createProcedure({
  input: t.object({}),
  output: t.object({ result: t.string() }),
  handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10000))
    return { result: 'too late' }
  },
})

const router = createRootRouter([
  createRouter({ routes: { echo: echoProcedure, slow: slowProcedure } }),
] as const)

// =============================================================================
// Tests
// =============================================================================

describe('Connection Lifecycle', () => {
  let setup: TestSetup<typeof router>

  beforeEach(async () => {
    setup = await createTestSetup({ router })
  })

  afterEach(async () => {
    await setup.cleanup()
  })

  describe('Connection Establishment', () => {
    it('should connect successfully and register connection in gateway', async () => {
      // The client is already connected in createTestSetup
      // Verify by checking gateway has exactly one connection
      expect(setup.gateway.connections.connections.size).toBe(1)

      // Verify by making a call
      const result = await setup.client.call.echo({ message: 'test' })
      expect(result).toEqual({ echoed: 'test' })
    })

    it('should emit connected event on client', async () => {
      // Create a fresh setup to test the connected event
      const newSetup = await createTestSetup({ router })

      // The client is already connected - verify connection is registered
      expect(newSetup.gateway.connections.connections.size).toBe(1)

      // Verify by making a call
      const result = await newSetup.client.call.echo({ message: 'test' })
      expect(result).toEqual({ echoed: 'test' })

      await newSetup.cleanup()
    })
  })

  describe('Disconnection', () => {
    it('should emit disconnected event on disconnect', async () => {
      const disconnectedHandler = vi.fn()
      setup.client.on('disconnected', disconnectedHandler)

      await setup.client.disconnect()

      expect(disconnectedHandler).toHaveBeenCalledWith('client')

      // Re-setup for cleanup
      setup = await createTestSetup({ router })
    })

    it('should reject pending calls on disconnect', async () => {
      const callPromise = setup.client.call.slow({})

      // Disconnect while call is pending
      setTimeout(() => setup.client.disconnect(), 50)

      await expect(callPromise).rejects.toThrow()

      // Re-setup for cleanup
      setup = await createTestSetup({ router })
    })

    it('should remove connection from gateway on disconnect', async () => {
      // Verify connection exists before disconnect
      expect(setup.gateway.connections.connections.size).toBe(1)

      await setup.client.disconnect()
      await waitForCleanup()

      // Verify connection is removed from gateway
      expect(setup.gateway.connections.connections.size).toBe(0)
      expect(setup.gateway.connections.streamIds.size).toBe(0)

      // Re-setup for cleanup
      setup = await createTestSetup({ router })
    })

    it('should clean up all gateway state on disconnect', async () => {
      // Make a call first to ensure state exists
      await setup.client.call.echo({ message: 'test' })

      // Verify initial state is clean after successful call
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)

      await setup.client.disconnect()
      await waitForCleanup()

      // Verify all gateway state is cleaned up
      expect(setup.gateway.connections.connections.size).toBe(0)
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)
      expect(setup.gateway.blobStreams.clientStreams.size).toBe(0)
      expect(setup.gateway.blobStreams.serverStreams.size).toBe(0)

      // Verify all client state is cleaned up
      expect(setup.client.isClean).toBe(true)

      // Re-setup for cleanup
      setup = await createTestSetup({ router })
    })

    it('should clean up pending RPC when disconnected during call', async () => {
      // Start a slow call and immediately attach a catch handler to prevent unhandled rejection
      const callPromise = setup.client.call.slow({}).catch((e) => e)

      // Wait a bit for the RPC to be registered
      await waitForCleanup()

      // Verify RPC is registered in gateway
      expect(setup.gateway.rpcs.rpcs.size).toBe(1)

      // Disconnect while call is pending
      await setup.client.disconnect()
      await waitForCleanup()

      // Verify RPC is cleaned up
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.connections.connections.size).toBe(0)

      // The call should have been rejected with an error
      const result = await callPromise
      expect(result).toBeInstanceOf(Error)

      // Re-setup for cleanup
      setup = await createTestSetup({ router })
    })
  })

  describe('Reconnection', () => {
    it('should allow reconnection after disconnect', async () => {
      // Disconnect first
      await setup.client.disconnect()
      await waitForCleanup()

      expect(setup.gateway.connections.connections.size).toBe(0)

      // Reconnect
      await setup.client.connect()
      await waitForCleanup()

      // Verify connection is re-established
      expect(setup.gateway.connections.connections.size).toBe(1)

      // Verify we can make calls again
      const result = await setup.client.call.echo({
        message: 'after reconnect',
      })
      expect(result).toEqual({ echoed: 'after reconnect' })
    })

    it('should have fresh gateway state after reconnection', async () => {
      // Make a call, then disconnect
      await setup.client.call.echo({ message: 'before' })
      await setup.client.disconnect()
      await waitForCleanup()

      // Reconnect
      await setup.client.connect()
      await waitForCleanup()

      // Verify fresh state - only one connection
      expect(setup.gateway.connections.connections.size).toBe(1)
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)

      // Make another call
      const result = await setup.client.call.echo({ message: 'after' })
      expect(result).toEqual({ echoed: 'after' })

      // Verify cleanup
      await waitForCleanup()
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
    })

    it('should not leak resources after multiple connect/disconnect cycles', async () => {
      const cycles = 5

      for (let i = 0; i < cycles; i++) {
        // Make a call
        const result = await setup.client.call.echo({ message: `cycle ${i}` })
        expect(result).toEqual({ echoed: `cycle ${i}` })

        // Disconnect
        await setup.client.disconnect()
        await waitForCleanup()

        // Verify all maps are clean
        expect(setup.gateway.connections.connections.size).toBe(0)
        expect(setup.gateway.rpcs.rpcs.size).toBe(0)
        expect(setup.gateway.blobStreams.clientStreams.size).toBe(0)
        expect(setup.gateway.blobStreams.serverStreams.size).toBe(0)
        expect(setup.client.isClean).toBe(true)

        // Reconnect
        await setup.client.connect()
        await waitForCleanup()

        // Verify connection is re-established
        expect(setup.gateway.connections.connections.size).toBe(1)
      }
    })
  })

  describe('Memory Leak Prevention', () => {
    it('should clear all client internal maps on disconnect', async () => {
      // Make a call to ensure there's some activity
      await setup.client.call.echo({ message: 'test' })

      // Disconnect
      await setup.client.disconnect()
      await waitForCleanup()

      // Verify all client internal maps are empty
      expect(setup.client.pendingCallsCount).toBe(0)
      expect(setup.client.activeClientStreamsCount).toBe(0)
      expect(setup.client.activeServerStreamsCount).toBe(0)
      expect(setup.client.activeRpcStreamsCount).toBe(0)
      expect(setup.client.isClean).toBe(true)

      // Re-setup for cleanup
      setup = await createTestSetup({ router })
    })

    it('should clear all gateway maps for disconnected connection', async () => {
      // Make a call to ensure there's some activity
      await setup.client.call.echo({ message: 'test' })

      // Disconnect
      await setup.client.disconnect()
      await waitForCleanup()

      // Verify all gateway maps are empty
      expect(setup.gateway.connections.connections.size).toBe(0)
      expect(setup.gateway.connections.streamIds.size).toBe(0)
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.rpcs.streams.size).toBe(0)
      expect(setup.gateway.blobStreams.clientStreams.size).toBe(0)
      expect(setup.gateway.blobStreams.serverStreams.size).toBe(0)
      expect(setup.gateway.blobStreams.clientCallStreams.size).toBe(0)
      expect(setup.gateway.blobStreams.serverCallStreams.size).toBe(0)

      // Re-setup for cleanup
      setup = await createTestSetup({ router })
    })

    it('should dispose connection container on disconnect', async () => {
      // Get the connection ID before disconnecting
      const connectionIds = Array.from(
        setup.gateway.connections.connections.keys(),
      )
      expect(connectionIds.length).toBe(1)

      // Disconnect
      await setup.client.disconnect()
      await waitForCleanup()

      // Verify the connection is removed (container was disposed)
      expect(setup.gateway.connections.connections.size).toBe(0)

      // Re-setup for cleanup
      setup = await createTestSetup({ router })
    })

    it('should reject pending calls with clean state on disconnect', async () => {
      // Start a slow call and immediately attach a catch handler to prevent unhandled rejection
      const callPromise = setup.client.call.slow({}).catch((e) => e)

      // Wait a bit for the RPC to be registered
      await waitForCleanup()

      // Verify there's a pending call
      expect(setup.client.pendingCallsCount).toBe(1)
      expect(setup.gateway.rpcs.rpcs.size).toBe(1)

      // Disconnect while call is pending
      await setup.client.disconnect()
      await waitForCleanup()

      // The call should have been rejected with an error
      const result = await callPromise
      expect(result).toBeInstanceOf(Error)

      // Verify all state is clean after rejection
      expect(setup.client.isClean).toBe(true)
      expect(setup.gateway.rpcs.rpcs.size).toBe(0)
      expect(setup.gateway.connections.connections.size).toBe(0)

      // Re-setup for cleanup
      setup = await createTestSetup({ router })
    })
  })
})
