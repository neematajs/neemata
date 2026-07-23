import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'

import type { Hooks } from 'crossws'
import { JsonFormat } from '@nmtjs/json-format/client'
import { encodeWsAuthSubprotocol, ProtocolVersion } from '@nmtjs/protocol'
import { WsTransportClient } from '@nmtjs/ws-client'
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

describe('deprecated authQueryParam against a pre-subprotocol server', () => {
  // a legacy (pre-subprotocol) server completes the upgrade without echoing
  // Sec-WebSocket-Protocol, and spec-enforcing clients fail any handshake
  // whose subprotocol offer went unanswered — so the opt-in must put the
  // token in the URL instead of offering a subprotocol
  it('completes the handshake and carries the token in the URL', async () => {
    const offeredSubprotocols: (string | undefined)[] = []
    const authParams: (string | null)[] = []

    const server = createHttpServer()
    server.on('upgrade', (req, socket) => {
      offeredSubprotocols.push(req.headers['sec-websocket-protocol'])
      authParams.push(
        new URL(req.url!, 'http://localhost').searchParams.get('auth'),
      )
      const accept = createHash('sha1')
        .update(
          `${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
        )
        .digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      // the closing handshake is irrelevant here — drop the TCP connection
      // on the client's close frame so disconnect() can settle
      socket.on('data', () => socket.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    const transport = new WsTransportClient(
      new JsonFormat(),
      ProtocolVersion.v1,
      { url: `ws://127.0.0.1:${port}`, authQueryParam: true },
    )

    try {
      await transport.connect({
        auth: 'legacy-token',
        onConnect: vi.fn(),
        onMessage: vi.fn(),
        onDisconnect: vi.fn(),
      })
      expect(authParams).toEqual(['legacy-token'])
      expect(offeredSubprotocols).toEqual([undefined])
    } finally {
      await transport.disconnect()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
