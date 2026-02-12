import { ConnectionType } from '@nmtjs/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BaseClientOptions } from '../src/core.ts'
import type { ClientTransportStartParams } from '../src/transport.ts'
import { StaticClient } from '../src/clients/static.ts'
import { browserConnectivityPlugin } from '../src/plugins/browser.ts'
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

describe('Browser plugin behavior (browser mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('reconnects on online event when disconnected', async () => {
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

    globalThis.window.dispatchEvent(new Event('online'))
    expect(transport.connect).toHaveBeenCalledTimes(1)

    client.dispose()
  })

  it('reconnects on focus event when disconnected', async () => {
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

    globalThis.window.dispatchEvent(new Event('focus'))
    expect(transport.connect).toHaveBeenCalledTimes(1)

    client.dispose()
  })

  it('reconnects on visibilitychange while visible and disconnected', async () => {
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

    globalThis.document.dispatchEvent(new Event('visibilitychange'))
    expect(transport.connect).toHaveBeenCalledTimes(1)

    client.dispose()
  })

  it('does not reconnect after manual client disconnect with reconnect plugin', async () => {
    const { factory, transport, simulateConnect, simulateDisconnect } =
      createMockBidirectionalTransport()

    const client = new StaticClient(
      {
        ...baseOptions,
        plugins: [reconnectPlugin(), browserConnectivityPlugin()],
      },
      factory,
      {},
    )

    const firstConnect = client.connect()
    simulateConnect()
    await firstConnect

    transport.connect.mockClear()
    simulateDisconnect('client')

    await vi.advanceTimersByTimeAsync(10000)
    expect(transport.connect).not.toHaveBeenCalled()

    client.dispose()
  })

  it('does not reconnect from browser events after dispose', async () => {
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
    client.dispose()

    globalThis.window.dispatchEvent(new Event('pageshow'))
    globalThis.window.dispatchEvent(new Event('online'))
    globalThis.window.dispatchEvent(new Event('focus'))

    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('does not start duplicate connects on event bursts', async () => {
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
    globalThis.window.dispatchEvent(new Event('online'))
    globalThis.window.dispatchEvent(new Event('focus'))

    expect(transport.connect).toHaveBeenCalledTimes(1)

    client.dispose()
  })
})
