import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StaticClient } from '../src/clients/static.ts'
import { browserConnectivityPlugin } from '../src/plugins/browser.ts'
import { heartbeatPlugin } from '../src/plugins/heartbeat.ts'
import { reconnectPlugin } from '../src/plugins/reconnect.ts'
import {
  createBaseOptions,
  createMockBidirectionalTransport,
} from './_helpers/transports.ts'

describe('Plugin composition (browser mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('browser connectivity plugin nudges reconnect on pageshow when reconnect is configured', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')

    const client = new StaticClient(
      {
        ...createBaseOptions(),
        plugins: [reconnectPlugin(), browserConnectivityPlugin()],
      },
      transport.factory,
      {},
    )

    const firstConnect = client.connect()
    transport.simulateConnect()
    await firstConnect

    connectSpy.mockClear()
    transport.simulateDisconnect('server')

    globalThis.window.dispatchEvent(new Event('pageshow'))
    await vi.advanceTimersByTimeAsync(0)

    expect(connectSpy).toHaveBeenCalledTimes(1)
  })

  it('heartbeat + reconnect + browser compose to recover after timeout', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')
    const disconnectSpy = vi.spyOn(transport.transport, 'disconnect')

    const client = new StaticClient(
      {
        ...createBaseOptions(),
        plugins: [
          reconnectPlugin(),
          browserConnectivityPlugin(),
          heartbeatPlugin({ interval: 100, timeout: 50 }),
        ],
      },
      transport.factory,
      {},
    )

    const connectPromise = client.connect()
    transport.simulateConnect()
    await connectPromise

    connectSpy.mockClear()

    await vi.advanceTimersByTimeAsync(200)
    expect(disconnectSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(0)

    globalThis.window.dispatchEvent(new Event('pageshow'))

    await vi.advanceTimersByTimeAsync(2000)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    client.dispose()
  })
})
