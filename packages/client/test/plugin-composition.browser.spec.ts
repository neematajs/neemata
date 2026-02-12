import { ConnectionType } from '@nmtjs/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BaseClientOptions } from '../src/core.ts'
import type { ClientTransportStartParams } from '../src/transport.ts'
import { StaticClient } from '../src/clients/static.ts'
import { browserConnectivityPlugin } from '../src/plugins/browser.ts'
import { heartbeatPlugin } from '../src/plugins/heartbeat.ts'
import { reconnectPlugin } from '../src/plugins/reconnect.ts'

const createMockBidirectionalTransport = () => {
  let connectHandler: ClientTransportStartParams | null = null
  let connectResolve: (() => void) | null = null

  const transport = {
    type: ConnectionType.Bidirectional as const,
    connect: vi.fn(async (params: ClientTransportStartParams) => {
      connectHandler = params
      return new Promise<void>((resolve) => {
        connectResolve = resolve
      })
    }),
    disconnect: vi.fn(async () => {
      connectHandler?.onDisconnect?.('client')
    }),
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
  }
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

describe('Plugin composition (browser mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('browser connectivity plugin nudges reconnect on pageshow', async () => {
    const { factory, transport, simulateConnect, simulateDisconnect } =
      createMockBidirectionalTransport()

    const client = new StaticClient(
      { ...baseOptions, plugins: [browserConnectivityPlugin()] },
      factory,
      {},
    )

    const firstConnect = client.connect()
    simulateConnect()
    await firstConnect

    transport.connect.mockClear()
    simulateDisconnect('server')

    globalThis.window.dispatchEvent(new Event('pageshow'))

    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('heartbeat + reconnect compose to recover after timeout', async () => {
    const { factory, transport, simulateConnect } =
      createMockBidirectionalTransport()

    const client = new StaticClient(
      {
        ...baseOptions,
        plugins: [
          reconnectPlugin(),
          browserConnectivityPlugin(),
          heartbeatPlugin({ interval: 100, timeout: 50 }),
        ],
      },
      factory,
      {},
    )

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    transport.connect.mockClear()

    await vi.advanceTimersByTimeAsync(200)
    expect(transport.disconnect).toHaveBeenCalledTimes(1)

    globalThis.window.dispatchEvent(new Event('pageshow'))

    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.connect).toHaveBeenCalledTimes(1)

    client.dispose()
  })
})
