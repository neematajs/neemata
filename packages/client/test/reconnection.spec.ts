import { ConnectionType, ErrorCode } from '@nmtjs/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BaseClientOptions } from '../src/core.ts'
import type { ClientTransportStartParams } from '../src/transport.ts'
import { StaticClient } from '../src/clients/static.ts'
import { reconnectPlugin } from '../src/plugins/reconnect.ts'

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
    simulateConnect: () => {
      if (connectResolve) {
        connectResolve()
        connectHandler?.onConnect?.()
      }
    },
    simulateDisconnect: (reason: 'server' | 'client' = 'server') => {
      connectHandler?.onDisconnect?.(reason)
    },
    setConnectFail: (fail: boolean, error?: Error) => {
      shouldFailConnect = fail
      connectError = error ?? null
    },
    rejectConnect: (error: Error) => connectReject?.(error),
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

const mockFormat = {
  contentType: 'test',
  encode: vi.fn((data) => new Uint8Array()),
  decode: vi.fn((data) => ({})),
  encodeRPC: vi.fn((data) => new Uint8Array()),
  decodeRPC: vi.fn((data) => ({})),
}

const baseOptions: BaseClientOptions = {
  contract: {} as any,
  protocol: 1,
  format: mockFormat as any,
}

describe('BaseClient Reconnection Plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('does not reconnect when reconnect plugin is not installed', async () => {
    const { factory, transport, simulateConnect, simulateDisconnect } =
      createMockBidirectionalTransport()
    const client = new StaticClient(baseOptions, factory, {})

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    transport.connect.mockClear()
    simulateDisconnect('server')
    await vi.advanceTimersByTimeAsync(120000)

    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('does not reconnect for unidirectional transport even with plugin installed', async () => {
    const { factory, transport } = createMockUnidirectionalTransport()
    const client = new StaticClient(
      { ...baseOptions, plugins: [reconnectPlugin()] },
      factory,
      {},
    )

    ;(client as any).emit('disconnected', 'server')
    await vi.advanceTimersByTimeAsync(10000)

    expect(transport.type).toBe(ConnectionType.Unidirectional)
    expect('connect' in transport).toBe(false)
  })

  it('reconnects after server disconnect when plugin is installed', async () => {
    const { factory, transport, simulateConnect, simulateDisconnect } =
      createMockBidirectionalTransport()
    const client = new StaticClient(
      { ...baseOptions, plugins: [reconnectPlugin()] },
      factory,
      {},
    )

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    transport.connect.mockClear()
    simulateDisconnect('server')

    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect after client-initiated disconnect', async () => {
    const { factory, transport, simulateConnect, simulateDisconnect } =
      createMockBidirectionalTransport()
    const client = new StaticClient(
      { ...baseOptions, plugins: [reconnectPlugin()] },
      factory,
      {},
    )

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    transport.connect.mockClear()
    simulateDisconnect('client')
    await vi.advanceTimersByTimeAsync(120000)

    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('retries when initial connect fails', async () => {
    const { factory, transport, setConnectFail } =
      createMockBidirectionalTransport()
    const client = new StaticClient(
      { ...baseOptions, plugins: [reconnectPlugin()] },
      factory,
      {},
    )

    setConnectFail(true, new Error('Connection failed'))
    await expect(client.connect()).rejects.toThrow('Connection failed')

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)

    expect(transport.connect).toHaveBeenCalledTimes(2)
  })

  it('uses exponential backoff and caps at 60000ms', async () => {
    const { factory, transport } = createMockBidirectionalTransport()
    transport.connect.mockImplementation(async () => {
      throw new Error('Connection failed')
    })

    const client = new StaticClient(
      { ...baseOptions, plugins: [reconnectPlugin()] },
      factory,
      {},
    )

    await (client as any).onDisconnect('server')

    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.connect).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(transport.connect).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(4000)
    expect(transport.connect).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(8000)
    expect(transport.connect).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(16000)
    expect(transport.connect).toHaveBeenCalledTimes(5)

    await vi.advanceTimersByTimeAsync(32000)
    expect(transport.connect).toHaveBeenCalledTimes(6)

    await vi.advanceTimersByTimeAsync(60000)
    expect(transport.connect).toHaveBeenCalledTimes(7)
  })

  it('resets backoff after successful reconnect', async () => {
    const { factory, transport } = createMockBidirectionalTransport()

    let callCount = 0
    transport.connect.mockImplementation(async (params) => {
      callCount++
      if (callCount <= 2) throw new Error('Connection failed')
      params.onConnect()
    })

    const client = new StaticClient(
      { ...baseOptions, plugins: [reconnectPlugin()] },
      factory,
      {},
    )

    await (client as any).onDisconnect('server')

    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.connect).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(transport.connect).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(4000)
    expect(transport.connect).toHaveBeenCalledTimes(3)

    transport.connect.mockClear()
    await (client as any).onDisconnect('server')

    await vi.advanceTimersByTimeAsync(999)
    expect(transport.connect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('stops reconnect loop after successful connection', async () => {
    const { factory, transport, simulateConnect, simulateDisconnect } =
      createMockBidirectionalTransport()
    const client = new StaticClient(
      { ...baseOptions, plugins: [reconnectPlugin()] },
      factory,
      {},
    )

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    transport.connect.mockClear()
    simulateDisconnect('server')

    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.connect).toHaveBeenCalledTimes(1)

    simulateConnect()
    await vi.advanceTimersByTimeAsync(0)

    transport.connect.mockClear()
    await vi.advanceTimersByTimeAsync(120000)
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('emits connected and disconnected events correctly with reconnect plugin', async () => {
    const { factory, transport, simulateConnect, simulateDisconnect } =
      createMockBidirectionalTransport()
    const client = new StaticClient(
      { ...baseOptions, plugins: [reconnectPlugin()] },
      factory,
      {},
    )

    const connectedHandler = vi.fn()
    const disconnectedHandler = vi.fn()

    client.on('connected', connectedHandler)
    client.on('disconnected', disconnectedHandler)

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    expect(connectedHandler).toHaveBeenCalledTimes(1)

    transport.connect.mockClear()
    simulateDisconnect('server')

    expect(disconnectedHandler).toHaveBeenCalledWith('server')

    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.connect).toHaveBeenCalledTimes(1)

    simulateConnect()
    await vi.advanceTimersByTimeAsync(0)

    expect(connectedHandler).toHaveBeenCalledTimes(2)
  })

  it('rejects pending calls on disconnect', async () => {
    const { factory, simulateConnect, simulateDisconnect } =
      createMockBidirectionalTransport()
    const client = new StaticClient(baseOptions, factory, {})

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    const callPromise = (client as any)._call('test', undefined, {})
    simulateDisconnect('server')

    await expect(callPromise).rejects.toMatchObject({
      code: ErrorCode.ConnectionError,
    })
  })

  it('returns existing connecting promise for concurrent connect calls', async () => {
    const { factory, transport, rejectConnect } =
      createMockBidirectionalTransport()
    const client = new StaticClient(
      { ...baseOptions, plugins: [reconnectPlugin()] },
      factory,
      {},
    )

    const promise1 = client.connect()
    const promise2 = client.connect()

    expect(promise1).toBe(promise2)
    expect(transport.connect).toHaveBeenCalledTimes(1)

    rejectConnect(new Error('connect failed'))
    await expect(promise1).rejects.toThrow('connect failed')
  })
})
