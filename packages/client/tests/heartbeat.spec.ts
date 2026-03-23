import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StaticClient } from '../src/clients/static.ts'
import { heartbeatPlugin } from '../src/plugins/heartbeat.ts'
import { reconnectPlugin } from '../src/plugins/reconnect.ts'
import {
  createBaseOptions,
  createMockBidirectionalTransport,
} from './_helpers/transports.ts'

describe('heartbeatPlugin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('forces reconnect when pong is not received in time', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')
    const disconnectSpy = vi.spyOn(transport.transport, 'disconnect')

    const client = new StaticClient(
      {
        ...createBaseOptions(),
        plugins: [
          reconnectPlugin(),
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

    await vi.advanceTimersByTimeAsync(1000)
    expect(connectSpy).toHaveBeenCalledTimes(1)
  })

  it('stops heartbeat loop on dispose', async () => {
    const transport = createMockBidirectionalTransport()
    const sendSpy = vi.spyOn(transport.transport, 'send')

    const client = new StaticClient(
      {
        ...createBaseOptions(),
        plugins: [heartbeatPlugin({ interval: 100, timeout: 50 })],
      },
      transport.factory,
      {},
    )

    const connectPromise = client.connect()
    transport.simulateConnect()
    await connectPromise

    await vi.advanceTimersByTimeAsync(100)
    const sendsBeforeDispose = sendSpy.mock.calls.length

    client.dispose()
    await vi.advanceTimersByTimeAsync(1000)

    expect(sendSpy.mock.calls.length).toBe(sendsBeforeDispose)
  })
})
