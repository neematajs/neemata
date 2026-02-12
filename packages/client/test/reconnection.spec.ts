import { ConnectionType, ErrorCode } from '@nmtjs/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BaseClientOptions } from '../src/core.ts'
import type { ClientTransportStartParams } from '../src/transport.ts'
import { StaticClient } from '../src/clients/static.ts'

// Mock transport for testing
const createMockBidirectionalTransport = () => {
  let connectHandler: ClientTransportStartParams | null = null
  let connectResolve: (() => void) | null = null
  let connectReject: ((error: Error) => void) | null = null
  let shouldFailConnect = false
  let connectError: Error | null = null

  const transport = {
    type: ConnectionType.Bidirectional as const,
    connect: vi.fn(async (params: ClientTransportStartParams) => {
      connectHandler = params
      return new Promise<void>((resolve, reject) => {
        connectResolve = resolve
        connectReject = reject
        if (shouldFailConnect) {
          reject(connectError ?? new Error('Connection failed'))
        }
      })
    }),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  }

  return {
    transport,
    factory: () => transport,
    // Simulate successful connection
    simulateConnect: () => {
      if (connectResolve) {
        connectResolve()
        connectHandler?.onConnect?.()
      }
    },
    // Simulate disconnection from server
    simulateDisconnect: (reason: 'server' | 'client' = 'server') => {
      connectHandler?.onDisconnect?.(reason)
    },
    // Make next connection attempt fail
    setConnectFail: (fail: boolean, error?: Error) => {
      shouldFailConnect = fail
      connectError = error ?? null
    },
    // Resolve pending connection
    resolveConnect: () => connectResolve?.(),
    rejectConnect: (error: Error) => connectReject?.(error),
    getConnectHandler: () => connectHandler,
  }
}

const createMockUnidirectionalTransport = () => {
  const transport = {
    type: ConnectionType.Unidirectional as const,
    call: vi.fn(async () => ({
      type: 'rpc' as const,
      result: new Uint8Array(),
    })),
  }

  return { transport, factory: () => transport }
}

// Mock format
const mockFormat = {
  contentType: 'test',
  encode: vi.fn((data) => new Uint8Array()),
  decode: vi.fn((data) => ({})),
  encodeRPC: vi.fn((data) => new Uint8Array()),
  decodeRPC: vi.fn((data) => ({})),
}

// Base options for client
const baseOptions: BaseClientOptions = {
  contract: {} as any,
  protocol: 1,
  format: mockFormat as any,
}

describe('BaseClient Reconnection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('autoreconnect option', () => {
    it('should not set up reconnection for unidirectional transport', async () => {
      const { factory, transport } = createMockUnidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Unidirectional transport doesn't have connect method
      expect(transport.type).toBe(ConnectionType.Unidirectional)

      // Emit disconnected - should not trigger reconnection loop
      ;(client as any).emit('disconnected', 'server')

      // Advance timers - no reconnection should occur (verified by no errors thrown)
      await vi.advanceTimersByTimeAsync(10000)

      // Unidirectional transports don't have connect/disconnect lifecycle
      expect('connect' in transport).toBe(false)
    })

    it('should not set up reconnection when autoreconnect is false', async () => {
      const { factory, transport, simulateConnect, simulateDisconnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: false },
        factory,
        {},
      )

      // Initial connect
      const connectPromise = client.connect()
      simulateConnect()
      await connectPromise

      // Reset mock to track reconnection attempts
      transport.connect.mockClear()

      // Simulate disconnection
      simulateDisconnect('server')

      // Advance timers significantly
      await vi.advanceTimersByTimeAsync(120000)

      // No reconnection attempts should be made
      expect(transport.connect).not.toHaveBeenCalled()
    })

    it('should set up reconnection for bidirectional transport with autoreconnect enabled', async () => {
      const { factory, transport, simulateConnect, simulateDisconnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Initial connect
      const connectPromise = client.connect()
      simulateConnect()
      await connectPromise

      // Reset mock to track reconnection attempts
      transport.connect.mockClear()

      // Simulate disconnection
      simulateDisconnect('server')

      // Advance timer past initial reconnect timeout (1000ms)
      await vi.advanceTimersByTimeAsync(1000)

      // Reconnection attempt should be made
      expect(transport.connect).toHaveBeenCalledTimes(1)
    })

    it('should not reconnect after client-initiated disconnect', async () => {
      const { factory, transport, simulateConnect, simulateDisconnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Initial connect
      const connectPromise = client.connect()
      simulateConnect()
      await connectPromise

      // Reset mock to track reconnection attempts
      transport.connect.mockClear()

      // Simulate client-initiated disconnect
      simulateDisconnect('client')

      // Advance timers significantly
      await vi.advanceTimersByTimeAsync(120000)

      // No reconnection attempts should be made
      expect(transport.connect).not.toHaveBeenCalled()
    })

    it('should retry when initial connect fails (autoreconnect enabled)', async () => {
      const { factory, transport, setConnectFail } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      setConnectFail(true, new Error('Connection failed'))

      await expect(client.connect()).rejects.toThrow('Connection failed')

      // Allow connect() rejection handlers to run
      await vi.advanceTimersByTimeAsync(0)

      // First retry after 1s
      await vi.advanceTimersByTimeAsync(1000)

      expect(transport.connect).toHaveBeenCalledTimes(2)
    })
  })

  describe('exponential backoff', () => {
    it('should use initial timeout of 1000ms for first reconnection attempt', async () => {
      const { factory, transport, simulateConnect, simulateDisconnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Initial connect
      const connectPromise = client.connect()
      simulateConnect()
      await connectPromise

      transport.connect.mockClear()
      simulateDisconnect('server')

      // Before 1000ms - no reconnection
      await vi.advanceTimersByTimeAsync(999)
      expect(transport.connect).not.toHaveBeenCalled()

      // At 1000ms - reconnection attempt
      await vi.advanceTimersByTimeAsync(1)
      expect(transport.connect).toHaveBeenCalledTimes(1)
    })

    it('should double timeout on each failed reconnection attempt', async () => {
      const { factory, transport } = createMockBidirectionalTransport()

      // Make connect always fail
      transport.connect.mockImplementation(async () => {
        throw new Error('Connection failed')
      })

      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Set initial state to connected, then disconnect
      ;(client as any).state = 'connected'
      ;(client as any).onDisconnect('server')

      // First attempt after 1000ms
      await vi.advanceTimersByTimeAsync(1000)
      expect(transport.connect).toHaveBeenCalledTimes(1)

      // Second attempt after 2000ms (doubled)
      await vi.advanceTimersByTimeAsync(2000)
      expect(transport.connect).toHaveBeenCalledTimes(2)

      // Third attempt after 4000ms (doubled again)
      await vi.advanceTimersByTimeAsync(4000)
      expect(transport.connect).toHaveBeenCalledTimes(3)

      // Fourth attempt after 8000ms
      await vi.advanceTimersByTimeAsync(8000)
      expect(transport.connect).toHaveBeenCalledTimes(4)
    })

    it('should cap timeout at maximum of 60000ms', async () => {
      const { factory, transport } = createMockBidirectionalTransport()

      // Make connect always fail
      transport.connect.mockImplementation(async () => {
        throw new Error('Connection failed')
      })

      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Set initial state to connected, then disconnect
      ;(client as any).state = 'connected'
      ;(client as any).onDisconnect('server')

      // Fast-forward through backoff sequence: 1s, 2s, 4s, 8s, 16s, 32s, 64s (capped to 60s)
      // Total: 1 + 2 + 4 + 8 + 16 + 32 = 63s for 6 attempts
      await vi.advanceTimersByTimeAsync(1000) // 1s
      expect(transport.connect).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2000) // 2s
      expect(transport.connect).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(4000) // 4s
      expect(transport.connect).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(8000) // 8s
      expect(transport.connect).toHaveBeenCalledTimes(4)

      await vi.advanceTimersByTimeAsync(16000) // 16s
      expect(transport.connect).toHaveBeenCalledTimes(5)

      await vi.advanceTimersByTimeAsync(32000) // 32s
      expect(transport.connect).toHaveBeenCalledTimes(6)

      // At this point timeout should be min(64000, 60000) = 60000
      // So next attempt after 60s
      await vi.advanceTimersByTimeAsync(59999)
      expect(transport.connect).toHaveBeenCalledTimes(6) // Not yet

      await vi.advanceTimersByTimeAsync(1)
      expect(transport.connect).toHaveBeenCalledTimes(7)

      // Verify subsequent attempts also use 60s max
      await vi.advanceTimersByTimeAsync(60000)
      expect(transport.connect).toHaveBeenCalledTimes(8)
    })
  })

  describe('successful reconnection', () => {
    it('should stop reconnection loop when connection succeeds', async () => {
      const { factory, transport, simulateConnect, simulateDisconnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Initial connect
      const connectPromise = client.connect()
      simulateConnect()
      await connectPromise

      transport.connect.mockClear()

      // Simulate disconnection
      simulateDisconnect('server')

      // First reconnection attempt
      await vi.advanceTimersByTimeAsync(1000)
      expect(transport.connect).toHaveBeenCalledTimes(1)

      // Simulate successful reconnection
      simulateConnect()
      await vi.advanceTimersByTimeAsync(0) // Allow promises to resolve

      transport.connect.mockClear()

      // No more reconnection attempts should be made
      await vi.advanceTimersByTimeAsync(120000)
      expect(transport.connect).not.toHaveBeenCalled()
    })

    it('should reset timeout to initial value on successful connection', async () => {
      const { factory, transport } = createMockBidirectionalTransport()

      let callCount = 0
      transport.connect.mockImplementation(async (params) => {
        callCount++
        // Fail first two attempts, succeed on third
        if (callCount <= 2) {
          throw new Error('Connection failed')
        }
        params.onConnect()
      })

      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Set initial state to connected, then disconnect
      ;(client as any).state = 'connected'
      ;(client as any).onDisconnect('server')

      // First attempt after 1s (fails)
      await vi.advanceTimersByTimeAsync(1000)
      expect(transport.connect).toHaveBeenCalledTimes(1)

      // Second attempt after 2s (fails)
      await vi.advanceTimersByTimeAsync(2000)
      expect(transport.connect).toHaveBeenCalledTimes(2)

      // Third attempt after 4s (succeeds)
      await vi.advanceTimersByTimeAsync(4000)
      expect(transport.connect).toHaveBeenCalledTimes(3)

      // Allow promises to settle
      await vi.advanceTimersByTimeAsync(0)

      // Verify timeout was reset by checking internal state
      expect((client as any).reconnectTimeout).toBe(1000)
    })
  })

  describe('reconnection loop behavior', () => {
    it('should only run reconnection loop while state is disconnected', async () => {
      const { factory, transport, simulateConnect, simulateDisconnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Initial connect
      const connectPromise = client.connect()
      simulateConnect()
      await connectPromise

      transport.connect.mockClear()

      // Simulate disconnection
      simulateDisconnect('server')

      // First reconnection attempt
      await vi.advanceTimersByTimeAsync(1000)
      expect(transport.connect).toHaveBeenCalledTimes(1)

      // Manually set state back to connected (simulating successful connect)
      ;(client as any).state = 'connected'

      // No more reconnection attempts should be made
      await vi.advanceTimersByTimeAsync(60000)
      expect(transport.connect).toHaveBeenCalledTimes(1)
    })

    it('should emit connected event on successful reconnection', async () => {
      const { factory, transport, simulateConnect, simulateDisconnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      const connectedHandler = vi.fn()
      client.on('connected', connectedHandler)

      // Initial connect
      const connectPromise = client.connect()
      simulateConnect()
      await connectPromise

      expect(connectedHandler).toHaveBeenCalledTimes(1)
      connectedHandler.mockClear()
      transport.connect.mockClear()

      // Simulate disconnection
      simulateDisconnect('server')

      // Trigger reconnection
      await vi.advanceTimersByTimeAsync(1000)
      expect(transport.connect).toHaveBeenCalledTimes(1)

      // Simulate successful reconnection
      simulateConnect()
      await vi.advanceTimersByTimeAsync(0)

      // Connected event should be emitted again
      expect(connectedHandler).toHaveBeenCalledTimes(1)
    })

    it('should emit disconnected event with correct reason', async () => {
      const { factory, simulateConnect, simulateDisconnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      const disconnectedHandler = vi.fn()
      client.on('disconnected', disconnectedHandler)

      // Initial connect
      const connectPromise = client.connect()
      simulateConnect()
      await connectPromise

      // Simulate server-initiated disconnect
      simulateDisconnect('server')
      expect(disconnectedHandler).toHaveBeenCalledWith('server')

      disconnectedHandler.mockClear()

      // Reconnect
      await vi.advanceTimersByTimeAsync(1000)
      simulateConnect()
      await vi.advanceTimersByTimeAsync(0)

      // Simulate client-initiated disconnect
      simulateDisconnect('client')
      expect(disconnectedHandler).toHaveBeenCalledWith('client')
    })

    it('should reject pending calls on disconnect', async () => {
      const { factory, simulateConnect, simulateDisconnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: false },
        factory,
        {},
      )

      const connectPromise = client.connect()
      simulateConnect()
      await connectPromise

      const callPromise = (client as any)._call('test', undefined, {})

      simulateDisconnect('server')

      await expect(callPromise).rejects.toMatchObject({
        code: ErrorCode.ConnectionError,
      })
    })
  })

  describe('connect method behavior', () => {
    it('should return immediately if already connected', async () => {
      const { factory, transport, simulateConnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Initial connect
      const connectPromise = client.connect()
      simulateConnect()
      await connectPromise

      transport.connect.mockClear()

      // Second connect call should return immediately
      await client.connect()

      // No new connect attempt should be made
      expect(transport.connect).not.toHaveBeenCalled()
    })

    it('should return existing connecting promise if connection is in progress', async () => {
      const { factory, transport, simulateConnect } =
        createMockBidirectionalTransport()
      const client = new StaticClient(
        { ...baseOptions, autoreconnect: true },
        factory,
        {},
      )

      // Start connecting
      const promise1 = client.connect()
      const promise2 = client.connect()

      // Should be the same promise
      expect(promise1).toBe(promise2)

      // Only one connect call should be made
      expect(transport.connect).toHaveBeenCalledTimes(1)

      // Complete connection
      simulateConnect()
      await promise1
      await promise2
    })
  })
})
