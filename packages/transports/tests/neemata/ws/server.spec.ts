import type { ServerHost } from '@nmtjs/transports/http-server'
import type { Peer } from 'crossws'
import { encodeWsAuthSubprotocol } from '@nmtjs/protocol'
import { JsonCodec } from '@nmtjs/protocol/json/server'
import { ProtocolCodecRegistry } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import { NeemataWebSocketHandler } from '../../../src/neemata/ws/server.ts'

const createTestCodecs = () => new ProtocolCodecRegistry([new JsonCodec()])

const createHost = (isSendSuccess: (status: number) => boolean = () => true) =>
  ({ isSendSuccess }) as unknown as ServerHost

const createHandler = (
  isSendSuccess?: (status: number) => boolean,
  params: Record<string, unknown> = {},
) =>
  new NeemataWebSocketHandler(
    params as any,
    createHost(isSendSuccess),
    createTestCodecs(),
    { path: '/', heartbeat: false },
  )

const setPeer = (handler: NeemataWebSocketHandler, send: () => unknown) => {
  const close = vi.fn()
  const peer = {
    send: vi.fn(send),
    close,
    context: { connectionId: 'c1' },
  } as unknown as Peer
  // register through the registry's own admission path; opened() claims the
  // pending entry, so no reap timer is left running behind the test
  handler.connections.admit('c1')
  handler.connections.opened('c1', peer)
  return { handler, peer, close }
}

describe('NeemataWebSocketHandler.send', () => {
  const buffer = new Uint8Array([0x01])

  it('delegates numeric send status interpretation to the host', () => {
    const isSendSuccess = (status: number) => status !== 2
    expect(
      setPeer(createHandler(isSendSuccess), () => 2).handler.send('c1', buffer),
    ).toBe('dropped')
    expect(
      setPeer(createHandler(isSendSuccess), () => 1).handler.send('c1', buffer),
    ).toBe('delivered')
    expect(
      setPeer(createHandler(isSendSuccess), () => 0).handler.send('c1', buffer),
    ).toBe('delivered')
  })

  it('passes boolean results through', () => {
    expect(
      setPeer(createHandler(), () => true).handler.send('c1', buffer),
    ).toBe('delivered')
    expect(
      setPeer(createHandler(), () => false).handler.send('c1', buffer),
    ).toBe('dropped')
  })

  it('reports no delivery feedback for a void send result', () => {
    // Deno's peer.send returns void; that must not read as a drop or every
    // send over that runtime would abort streams
    expect(
      setPeer(createHandler(), () => undefined).handler.send('c1', buffer),
    ).toBe('unknown')
  })

  it('drops sends to unknown connections', () => {
    expect(createHandler().send('missing', buffer)).toBe('dropped')
  })

  it('leaves disconnect ownership to the close hook when send throws', async () => {
    const onDisconnect = vi.fn(async () => {})
    const { handler, peer } = setPeer(
      createHandler(undefined, { onDisconnect }),
      () => {
        throw new Error('boom')
      },
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(handler.send('c1', buffer)).toBe('dropped')
    expect(handler.connections.peer('c1')).toBe(peer)

    await handler.hooks.close!(peer, {})

    expect(handler.connections.peer('c1')).toBeUndefined()
    expect(onDisconnect).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })
})

describe('NeemataWebSocketHandler.message', () => {
  it('leaves disconnect ownership to the close hook after a message error', async () => {
    const onDisconnect = vi.fn(async () => {})
    const { handler, peer, close } = setPeer(
      createHandler(undefined, { onDisconnect }),
      () => true,
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.hooks.message!(peer, {
      arrayBuffer: () => new ArrayBuffer(0),
    } as any)

    expect(close).toHaveBeenCalledWith(1011, 'Internal error')
    expect(handler.connections.peer('c1')).toBe(peer)
    await handler.hooks.close!(peer, {})
    expect(handler.connections.peer('c1')).toBeUndefined()
    expect(onDisconnect).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })
})

describe('NeemataWebSocketHandler.upgrade', () => {
  it('propagates the upgrade request abort signal to connection data', async () => {
    let connectionData: Request | undefined
    const onConnect = vi.fn(async (options) => {
      connectionData = options.data
      return { id: 'c1' }
    })
    const handler = createHandler(undefined, {
      onConnect,
      onDisconnect: vi.fn(async () => {}),
    })
    const controller = new AbortController()

    await handler.hooks.upgrade!(
      new Request('http://localhost/ws', {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        signal: controller.signal,
      }),
    )
    controller.abort()

    expect(connectionData).toBeInstanceOf(Request)
    expect(connectionData?.signal.aborted).toBe(true)
    await handler.dispose()
  })

  it('exposes subprotocol auth through Authorization and echoes it exactly', async () => {
    let connectionData: Request | undefined
    const handler = createHandler(undefined, {
      onConnect: vi.fn(async (options) => {
        connectionData = options.data
        return { id: 'c1' }
      }),
      onDisconnect: vi.fn(async () => {}),
    })
    const subprotocol = encodeWsAuthSubprotocol('Bearer secret')

    const result = await handler.hooks.upgrade!(
      new Request('http://localhost/ws', {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'sec-websocket-protocol': `chat, ${subprotocol}`,
        },
      }),
    )

    expect(connectionData).toBeInstanceOf(Request)
    expect(connectionData?.headers.get('authorization')).toBe('Bearer secret')
    expect(result).toMatchObject({
      headers: { 'sec-websocket-protocol': subprotocol },
    })
    await handler.dispose()
  })

  it('leaves foreign subprotocol offers unselected', async () => {
    let connectionData: Request | undefined
    const handler = createHandler(undefined, {
      onConnect: vi.fn(async (options) => {
        connectionData = options.data
        return { id: 'c1' }
      }),
      onDisconnect: vi.fn(async () => {}),
    })

    const result = await handler.hooks.upgrade!(
      new Request('http://localhost/ws', {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'sec-websocket-protocol': 'chat, graphql-ws',
        },
      }),
    )

    expect(connectionData?.headers.get('authorization')).toBeNull()
    expect((result as { headers?: unknown }).headers).toBeUndefined()
    await handler.dispose()
  })
})

describe('NeemataWebSocketHandler termination', () => {
  it('delivers exactly one disconnect for a session-initiated close', async () => {
    const onDisconnect = vi.fn(async () => {})
    const { handler, peer, close } = setPeer(
      createHandler(undefined, { onDisconnect }),
      () => true,
    )

    // session-initiated termination (heartbeat timeout, dropped terminal
    // frame) closes the socket and owns the disconnect
    await handler.connections.disconnect('c1', { code: 4000, reason: 'bye' })

    expect(close).toHaveBeenCalledWith(4000, 'bye')
    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(handler.connections.peer('c1')).toBeUndefined()

    // the runtime close hook fires later for the peer we just closed; the
    // termination already claimed it, so no duplicate onDisconnect
    await handler.hooks.close!(peer, {})
    expect(onDisconnect).toHaveBeenCalledOnce()
  })
})
