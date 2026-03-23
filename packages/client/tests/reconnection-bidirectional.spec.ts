import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StaticClient } from '../src/clients/static.ts'
import { reconnectPlugin } from '../src/plugins/reconnect.ts'
import {
  createBaseOptions,
  createMockBidirectionalTransport,
} from './_helpers/transports.ts'

describe('reconnectPlugin (bidirectional)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('does not reconnect when reconnect plugin is not installed', async () => {
    const transport = createMockBidirectionalTransport()
    const client = new StaticClient(createBaseOptions(), transport.factory, {})

    const connectPromise = client.connect()
    transport.simulateConnect()
    await connectPromise

    const connectSpy = vi.spyOn(transport.transport, 'connect')
    connectSpy.mockClear()

    transport.simulateDisconnect('server')
    await vi.advanceTimersByTimeAsync(120000)

    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('reconnects after server disconnect when plugin is installed', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')

    const client = new StaticClient(
      { ...createBaseOptions(), plugins: [reconnectPlugin()] },
      transport.factory,
      {},
    )

    const connectPromise = client.connect()
    transport.simulateConnect()
    await connectPromise

    connectSpy.mockClear()
    transport.simulateDisconnect('server')

    await vi.advanceTimersByTimeAsync(1000)
    expect(connectSpy).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect after client-initiated disconnect', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')

    const client = new StaticClient(
      { ...createBaseOptions(), plugins: [reconnectPlugin()] },
      transport.factory,
      {},
    )

    const connectPromise = client.connect()
    transport.simulateConnect()
    await connectPromise

    connectSpy.mockClear()
    await client.disconnect()
    await vi.advanceTimersByTimeAsync(120000)

    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('retries when initial connect fails', async () => {
    const transport = createMockBidirectionalTransport()
    transport.setConnectFail(true, new Error('Connection failed'))
    const connectSpy = vi.spyOn(transport.transport, 'connect')

    const client = new StaticClient(
      { ...createBaseOptions(), plugins: [reconnectPlugin()] },
      transport.factory,
      {},
    )

    await expect(client.connect()).rejects.toThrow('Connection failed')

    await vi.advanceTimersByTimeAsync(1000)
    expect(connectSpy).toHaveBeenCalledTimes(2)
  })

  it('uses exponential backoff and caps at configured max timeout', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')
    transport.setConnectFail(true, new Error('Connection failed'))

    const client = new StaticClient(
      {
        ...createBaseOptions(),
        plugins: [reconnectPlugin({ initialTimeout: 1000, maxTimeout: 60000 })],
      },
      transport.factory,
      {},
    )

    await expect(client.connect()).rejects.toThrow('Connection failed')
    connectSpy.mockClear()

    await vi.advanceTimersByTimeAsync(1000)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(connectSpy).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(4000)
    expect(connectSpy).toHaveBeenCalledTimes(3)
  })

  it('resets backoff after successful reconnect', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')
    transport.setConnectFail(true, new Error('Connection failed'))

    const client = new StaticClient(
      { ...createBaseOptions(), plugins: [reconnectPlugin()] },
      transport.factory,
      {},
    )

    await expect(client.connect()).rejects.toThrow('Connection failed')
    connectSpy.mockClear()

    await vi.advanceTimersByTimeAsync(1000)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    transport.setConnectFail(false)

    await vi.advanceTimersByTimeAsync(2000)
    transport.simulateConnect()
    expect(connectSpy).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(4000)
    expect(connectSpy).toHaveBeenCalledTimes(2)

    connectSpy.mockClear()
    transport.simulateDisconnect('server')

    await vi.advanceTimersByTimeAsync(1000)
    expect(connectSpy).toHaveBeenCalledTimes(1)
  })

  it('returns existing connecting promise for concurrent connect calls', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')

    const client = new StaticClient(
      { ...createBaseOptions(), plugins: [reconnectPlugin()] },
      transport.factory,
      {},
    )

    const promise1 = client.connect()
    const promise2 = client.connect()

    expect(promise1).toBe(promise2)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    transport.rejectConnect(new Error('connect failed'))
    await expect(promise1).rejects.toThrow('connect failed')
  })
})
