import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StaticClient } from '../src/clients/static.ts'
import { browserConnectivityPlugin } from '../src/plugins/browser.ts'
import { reconnectPlugin } from '../src/plugins/reconnect.ts'
import {
  createBaseOptions,
  createMockBidirectionalTransport,
} from './_helpers/transports.ts'

describe('Browser plugin behavior (browser mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('reconnects on online event when disconnected and reconnect is configured', async () => {
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

    globalThis.window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    client.dispose()
  })

  it('reconnects on focus event when disconnected and reconnect is configured', async () => {
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

    globalThis.window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    client.dispose()
  })

  it('reconnects on visibilitychange while visible and disconnected', async () => {
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

    globalThis.document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    client.dispose()
  })

  it('does not reconnect from browser events after dispose', async () => {
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
    client.dispose()

    globalThis.window.dispatchEvent(new Event('pageshow'))
    globalThis.window.dispatchEvent(new Event('online'))
    globalThis.window.dispatchEvent(new Event('focus'))

    await vi.advanceTimersByTimeAsync(0)
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('does not start duplicate connects on event bursts', async () => {
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
    globalThis.window.dispatchEvent(new Event('online'))
    globalThis.window.dispatchEvent(new Event('focus'))

    await vi.advanceTimersByTimeAsync(0)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    client.dispose()
  })
})
