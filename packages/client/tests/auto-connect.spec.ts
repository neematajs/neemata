import { c } from '@nmtjs/contract'
import { ErrorCode, ServerMessageType } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StaticClient } from '../src/clients/static.ts'
import {
  createBaseOptions,
  createMockBidirectionalTransport,
  createMockUnidirectionalTransport,
  mockFormat,
} from './_helpers/transports.ts'

const contract = c.router({
  routes: {
    echo: c.procedure({
      input: t.object({ message: t.string() }),
      output: t.object({ echoed: t.string() }),
    }),
  },
})

const stubBidirectionalProtocol = (
  client: StaticClient<any, typeof contract>,
) => {
  ;(client.core.protocol as any).encodeMessage = vi.fn(
    () => new Uint8Array([1]),
  )

  const decodeMessage = vi.fn()
  ;(client.core.protocol as any).decodeMessage = decodeMessage

  return decodeMessage
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('autoConnect', () => {
  it('connects on the first bidirectional call when autoConnect is enabled', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')
    const sendSpy = vi.spyOn(transport.transport, 'send')

    const client = new StaticClient(
      createBaseOptions({ contract, autoConnect: true }),
      transport.factory,
      {},
    )

    const decodeMessage = stubBidirectionalProtocol(client)
    decodeMessage.mockReturnValueOnce({
      type: ServerMessageType.RpcResponse,
      callId: 0,
      result: { echoed: 'hello' },
    })

    const callPromise = client.call.echo({ message: 'hello' })

    expect(connectSpy).toHaveBeenCalledTimes(1)
    expect(client.state).toBe('connecting')

    transport.simulateConnect()
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(1)
    })

    transport.emitMessage(new Uint8Array([1]))

    await expect(callPromise).resolves.toEqual({ echoed: 'hello' })

    client.dispose()
  })

  it('reconnects on a bidirectional call after a server disconnect', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')
    const sendSpy = vi.spyOn(transport.transport, 'send')

    const client = new StaticClient(
      createBaseOptions({ contract, autoConnect: true }),
      transport.factory,
      {},
    )

    stubBidirectionalProtocol(client)

    const initialConnect = client.connect()
    transport.simulateConnect()
    await initialConnect

    transport.simulateDisconnect('server')
    connectSpy.mockClear()
    sendSpy.mockClear()

    const decodeMessage = client.core.protocol.decodeMessage as ReturnType<
      typeof vi.fn
    >
    decodeMessage.mockReturnValueOnce({
      type: ServerMessageType.RpcResponse,
      callId: 0,
      result: { echoed: 'again' },
    })

    const callPromise = client.call.echo({ message: 'again' })

    expect(connectSpy).toHaveBeenCalledTimes(1)
    expect(client.state).toBe('connecting')

    transport.simulateConnect()
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(1)
    })

    transport.emitMessage(new Uint8Array([2]))

    await expect(callPromise).resolves.toEqual({ echoed: 'again' })

    client.dispose()
  })

  it('does not reconnect on a bidirectional call after manual disconnect', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')
    const sendSpy = vi.spyOn(transport.transport, 'send')

    const client = new StaticClient(
      createBaseOptions({ contract, autoConnect: true }),
      transport.factory,
      {},
    )

    stubBidirectionalProtocol(client)

    const initialConnect = client.connect()
    transport.simulateConnect()
    await initialConnect

    await client.disconnect()
    connectSpy.mockClear()
    sendSpy.mockClear()

    await expect(
      client.call.echo({ message: 'blocked' }),
    ).rejects.toMatchObject({
      code: ErrorCode.ConnectionError,
      message: 'Client is not connected',
    })

    expect(connectSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()

    client.dispose()
  })

  it('keeps default bidirectional behavior when autoConnect is disabled', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')

    const client = new StaticClient(
      createBaseOptions({ contract }),
      transport.factory,
      {},
    )

    stubBidirectionalProtocol(client)

    await expect(client.call.echo({ message: 'hello' })).rejects.toMatchObject({
      code: ErrorCode.ConnectionError,
      message: 'Client is not connected',
    })

    expect(connectSpy).not.toHaveBeenCalled()

    client.dispose()
  })

  it('shares a single bidirectional connect attempt across concurrent calls', async () => {
    const transport = createMockBidirectionalTransport()
    const connectSpy = vi.spyOn(transport.transport, 'connect')
    const sendSpy = vi.spyOn(transport.transport, 'send')

    const client = new StaticClient(
      createBaseOptions({ contract, autoConnect: true }),
      transport.factory,
      {},
    )

    const decodeMessage = stubBidirectionalProtocol(client)
    decodeMessage
      .mockReturnValueOnce({
        type: ServerMessageType.RpcResponse,
        callId: 0,
        result: { echoed: 'first' },
      })
      .mockReturnValueOnce({
        type: ServerMessageType.RpcResponse,
        callId: 1,
        result: { echoed: 'second' },
      })

    const first = client.call.echo({ message: 'first' })
    const second = client.call.echo({ message: 'second' })

    expect(connectSpy).toHaveBeenCalledTimes(1)
    expect(client.state).toBe('connecting')

    transport.simulateConnect()
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(2)
    })

    transport.emitMessage(new Uint8Array([3]))
    transport.emitMessage(new Uint8Array([4]))

    await expect(first).resolves.toEqual({ echoed: 'first' })
    await expect(second).resolves.toEqual({ echoed: 'second' })

    client.dispose()
  })

  it('connects on the first unidirectional call when autoConnect is enabled', async () => {
    const callSpy = vi.fn(async () => ({
      type: 'rpc' as const,
      result: mockFormat.encode({ echoed: 'hello' }),
    }))
    const transport = createMockUnidirectionalTransport(callSpy)

    const client = new StaticClient(
      createBaseOptions({ contract, autoConnect: true }),
      transport.factory,
      {},
    )

    await expect(client.call.echo({ message: 'hello' })).resolves.toEqual({
      echoed: 'hello',
    })

    expect(callSpy).toHaveBeenCalledTimes(1)
    expect(client.state).toBe('connected')

    client.dispose()
  })

  it('blocks unidirectional calls after manual disconnect when autoConnect is enabled', async () => {
    const callSpy = vi.fn(async () => ({
      type: 'rpc' as const,
      result: mockFormat.encode({ echoed: 'hello' }),
    }))
    const transport = createMockUnidirectionalTransport(callSpy)

    const client = new StaticClient(
      createBaseOptions({ contract, autoConnect: true }),
      transport.factory,
      {},
    )

    await client.connect()
    await client.disconnect()

    await expect(client.call.echo({ message: 'hello' })).rejects.toMatchObject({
      code: ErrorCode.ConnectionError,
      message: 'Client is not connected',
    })

    expect(callSpy).not.toHaveBeenCalled()
    expect(client.state).toBe('disconnected')

    client.dispose()
  })
})
