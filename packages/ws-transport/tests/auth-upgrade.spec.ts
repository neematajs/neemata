import type { Hooks } from 'crossws'
import { encodeWsAuthSubprotocol } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { WsTransport } from '../src/runtimes/node.ts'
import { WsTransportServer } from '../src/server.ts'

const createServer = () => {
  let hooks: Hooks
  const adapterFactory = vi.fn((params: any) => {
    hooks = params.wsHooks
    return {
      start: vi.fn(async () => 'ws://test'),
      stop: vi.fn(async () => {}),
    }
  })

  const server = new WsTransportServer(adapterFactory, {
    listen: { port: 0 },
  })

  return { server, getHooks: () => hooks! }
}

const upgradeRequest = (options: {
  url?: string
  subprotocols?: string
}): any => ({
  url: options.url ?? 'http://localhost/',
  headers: new Headers(
    options.subprotocols
      ? { 'sec-websocket-protocol': options.subprotocols }
      : {},
  ),
  method: 'GET',
})

describe('WsTransportServer auth upgrade', () => {
  it('extracts the token from the auth subprotocol and echoes it back', async () => {
    const { server, getHooks } = createServer()
    const onConnect = vi.fn(async (_options: any) => ({ id: 'conn-1' }))
    await server.start({ onConnect, onDisconnect: vi.fn() } as any)

    const subprotocol = encodeWsAuthSubprotocol('Bearer secret')
    const result = await getHooks().upgrade!(
      upgradeRequest({ subprotocols: subprotocol }),
    )

    expect(onConnect.mock.calls[0][0]).toMatchObject({
      data: { auth: 'Bearer secret' },
    })
    // without the echo, browsers fail the handshake
    expect(result).toMatchObject({
      headers: { 'sec-websocket-protocol': subprotocol },
    })
  })

  it('falls back to the deprecated auth query parameter', async () => {
    const { server, getHooks } = createServer()
    const onConnect = vi.fn(async (_options: any) => ({ id: 'conn-1' }))
    await server.start({ onConnect, onDisconnect: vi.fn() } as any)

    const result = await getHooks().upgrade!(
      upgradeRequest({ url: 'http://localhost/?auth=legacy-token' }),
    )

    expect(onConnect.mock.calls[0][0]).toMatchObject({
      data: { auth: 'legacy-token' },
    })
    // no subprotocol was offered, so none may be selected
    expect((result as any).headers).toBeUndefined()
  })

  it('prefers the subprotocol token over the query parameter', async () => {
    const { server, getHooks } = createServer()
    const onConnect = vi.fn(async (_options: any) => ({ id: 'conn-1' }))
    await server.start({ onConnect, onDisconnect: vi.fn() } as any)

    await getHooks().upgrade!(
      upgradeRequest({
        url: 'http://localhost/?auth=stale',
        subprotocols: encodeWsAuthSubprotocol('fresh'),
      }),
    )

    expect(onConnect.mock.calls[0][0]).toMatchObject({
      data: { auth: 'fresh' },
    })
  })

  it('leaves foreign subprotocols alone', async () => {
    const { server, getHooks } = createServer()
    const onConnect = vi.fn(async (_options: any) => ({ id: 'conn-1' }))
    await server.start({ onConnect, onDisconnect: vi.fn() } as any)

    const result = await getHooks().upgrade!(
      upgradeRequest({ subprotocols: 'chat, graphql-ws' }),
    )

    expect(onConnect.mock.calls[0][0]).toMatchObject({
      data: { auth: null },
    })
    expect((result as any).headers).toBeUndefined()
  })
})

describe('auth subprotocol handshake over a real uWS transport', () => {
  // Node's WebSocket enforces RFC 6455: when protocols are offered, the
  // handshake fails unless the server echoes one of them back — so a
  // successful `open` also proves the echo
  it('authenticates a real client and completes the handshake', async () => {
    const server = WsTransport.factory({
      listen: { port: 0, hostname: '127.0.0.1' },
    }) as WsTransportServer
    const onConnect = vi.fn(async (_options: any) => ({ id: 'conn-1' }))

    const url = await server.start({
      onConnect,
      onDisconnect: vi.fn(async () => {}),
      onMessage: vi.fn(async () => {}),
    } as any)

    const subprotocol = encodeWsAuthSubprotocol('Bearer e2e-token')
    const ws = new WebSocket(url.replace(/^http/, 'ws'), [subprotocol])

    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', () =>
          reject(new Error('WebSocket handshake failed')),
        )
      })

      expect(ws.protocol).toBe(subprotocol)
      expect(onConnect.mock.calls[0][0]).toMatchObject({
        data: { auth: 'Bearer e2e-token' },
      })
    } finally {
      ws.close()
      await server.stop()
    }
  })

  it('still authenticates a legacy client via the auth query parameter', async () => {
    const server = WsTransport.factory({
      listen: { port: 0, hostname: '127.0.0.1' },
    }) as WsTransportServer
    const onConnect = vi.fn(async (_options: any) => ({ id: 'conn-1' }))

    const url = await server.start({
      onConnect,
      onDisconnect: vi.fn(async () => {}),
      onMessage: vi.fn(async () => {}),
    } as any)

    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/?auth=legacy`)

    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', () =>
          reject(new Error('WebSocket handshake failed')),
        )
      })

      expect(onConnect.mock.calls[0][0]).toMatchObject({
        data: { auth: 'legacy' },
      })
    } finally {
      ws.close()
      await server.stop()
    }
  })
})
