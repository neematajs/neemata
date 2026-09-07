import { c } from '@nmtjs/contract'
import { ErrorCode, ServerMessageType } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StaticClient } from '../src/clients/static.ts'
import { reconnectPlugin } from '../src/plugins/reconnect.ts'
import {
  createBaseOptions,
  createMockBidirectionalTransport,
} from './_helpers/transports.ts'

const contract = c.router({
  routes: {
    echo: c.procedure({
      input: t.object({ message: t.string() }),
      output: t.object({ echoed: t.string() }),
    }),
  },
})

describe('reconnectPlugin (bidirectional)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
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

  it('applies reconnect jitter outside browser environments', async () => {
    // near-max jitter: delay = timeout + floor(timeout * 0.2 * 0.995) = 1199
    vi.spyOn(Math, 'random').mockReturnValue(0.995)

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
    expect(connectSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(199)
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

  it('keeps RPC auto-connect within the active reconnect loop', async () => {
    const transport = createMockBidirectionalTransport()
    transport.setConnectFail(true, new Error('Connection failed'))
    const connectSpy = vi.spyOn(transport.transport, 'connect')
    const sendSpy = vi.spyOn(transport.transport, 'send')

    const client = new StaticClient(
      {
        ...createBaseOptions({ contract, autoConnect: true }),
        plugins: [reconnectPlugin({ initialTimeout: 1000 })],
      },
      transport.factory,
      {},
    )

    ;(client.core.protocol as any).encodeMessage = vi.fn(
      () => new Uint8Array([1]),
    )
    ;(client.core.protocol as any).decodeMessage = vi.fn(() => ({
      type: ServerMessageType.RpcResponse,
      callId: 1,
      result: { echoed: 'during reconnect' },
    }))

    await expect(client.connect()).rejects.toThrow('Connection failed')
    expect(connectSpy).toHaveBeenCalledTimes(1)

    await expect(
      client.call.echo({ message: 'during backoff' }),
    ).rejects.toMatchObject({
      code: ErrorCode.ConnectionError,
      message: 'Client is not connected',
    })
    expect(connectSpy).toHaveBeenCalledTimes(1)

    transport.setConnectFail(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(connectSpy).toHaveBeenCalledTimes(2)
    expect(client.state).toBe('connecting')

    const callPromise = client.call.echo({ message: 'during reconnect' })
    expect(connectSpy).toHaveBeenCalledTimes(2)

    transport.simulateConnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    transport.emitMessage(new Uint8Array([1]))

    await expect(callPromise).resolves.toEqual({ echoed: 'during reconnect' })

    client.dispose()
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
