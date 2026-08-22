import { connect } from 'node:net'

import { defineHooks } from 'crossws'
import { describe, expect, it, vi } from 'vitest'

const { createServerHost } = globalThis.Bun
  ? await import('../../src/http-server/bun.ts')
  : await import('../../src/http-server/node.ts')

const openSocket = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('WebSocket failed to connect'))
  })

/**
 * Raw WebSocket handshake request that surfaces the plain HTTP status a
 * non-101 answer carries — the WebSocket client API hides it behind a
 * generic connection error.
 */
const upgradeStatus = (url: string, path: string) =>
  new Promise<number>((resolve, reject) => {
    const { hostname, port } = new URL(url)
    const socket = connect({ host: hostname, port: Number(port) })
    let response = ''

    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${hostname}:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'),
      )
    })
    socket.on('data', (chunk) => {
      response += chunk
      const match = response.match(/^HTTP\/1\.1 (\d{3})/)
      if (!match) return
      socket.destroy()
      resolve(Number(match[1]))
    })
  })

const echoHooks = (prefix: string) =>
  defineHooks({
    message(peer, message) {
      peer.send(`${prefix}:${message.text()}`)
    },
  })

describe('server host', () => {
  it('serves mounted HTTP and WebSocket handlers plus /healthy', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    host.mountFetchHandler({
      path: '/',
      handler: async (request) =>
        new Response(`fallback:${new URL(request.url).pathname}`),
    })
    host.mountFetchHandler({
      path: '/rpc',
      handler: async (request) =>
        new Response(`rpc:${new URL(request.url).pathname}`),
    })
    host.mountWebSocket({ path: '/ws', hooks: echoHooks('ws') })
    host.mountWebSocket({ path: '/ws/admin', hooks: echoHooks('admin') })
    host.mountWebSocket({ path: '/events', hooks: echoHooks('events') })

    const url = await host.start()
    try {
      await expect(
        fetch(`${url}/rpc`).then((response) => response.text()),
      ).resolves.toBe('rpc:/rpc')
      await expect(
        fetch(`${url}/rpc/nested`).then((response) => response.text()),
      ).resolves.toBe('rpc:/rpc/nested')
      await expect(
        fetch(`${url}/rpcish`).then((response) => response.text()),
      ).resolves.toBe('fallback:/rpcish')
      expect((await fetch(`${url}/healthy`)).status).toBe(200)

      for (const [path, prefix] of [
        ['/ws', 'ws'],
        ['/ws/room-1', 'ws'],
        ['/ws/admin/room-1', 'admin'],
        ['/events', 'events'],
      ] as const) {
        const socket = await openSocket(`${url.replace('http', 'ws')}${path}`)
        const reply = new Promise<string>((resolve) => {
          socket.onmessage = (event) => resolve(String(event.data))
        })
        socket.send('ping')
        expect(await reply).toBe(`${prefix}:ping`)
        socket.close()
      }
      await expect(
        openSocket(`${url.replace('http', 'ws')}/missing`),
      ).rejects.toThrow()
      await expect(
        openSocket(`${url.replace('http', 'ws')}/wsish`),
      ).rejects.toThrow()
    } finally {
      await host.stop()
    }
  })

  it('starts idempotently and one stop closes the socket', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    const first = await host.start()
    expect(host.native[host.runtime]).toBeDefined()
    expect(await host.start()).toBe(first)
    // upgrade attempts without any WebSocket mount still get the reserved
    // /healthy answer from the shared router
    expect(await upgradeStatus(first, '/healthy')).toBe(200)
    await host.stop()
    expect(host.native[host.runtime]).toBeUndefined()
    await expect(fetch(`${first}/healthy`)).rejects.toThrow()
  })

  it('keeps /healthy outside a root WebSocket mount', async () => {
    const upgrade = vi.fn()
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    host.mountWebSocket({ path: '/', hooks: defineHooks({ upgrade }) })

    const url = await host.start()
    try {
      expect((await fetch(`${url}/healthy`)).status).toBe(200)
      // an upgrade attempt gets the plain 200 reserved response, not a 101
      expect(await upgradeStatus(url, '/healthy')).toBe(200)
      await expect(
        openSocket(`${url.replace('http', 'ws')}/healthy`),
      ).rejects.toThrow()
      expect(upgrade).not.toHaveBeenCalled()
    } finally {
      await host.stop()
    }
  })

  it('rebinds after a full stop', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    const first = await host.start()
    await host.stop()
    const second = await host.start()
    try {
      expect((await fetch(`${second}/healthy`)).status).toBe(200)
    } finally {
      await host.stop()
    }
    expect(first).not.toBe('')
    expect(second).not.toBe('')
  })

  it('rejects duplicate, reserved, and late mounts', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    host.mountFetchHandler({
      path: '/',
      handler: async () => new Response('ok'),
    })
    expect(() =>
      host.mountFetchHandler({
        path: '/',
        handler: async () => new Response('no'),
      }),
    ).toThrow('already mounted')
    host.mountFetchHandler({
      path: '/rpc',
      handler: async () => new Response('rpc'),
    })
    expect(() =>
      host.mountFetchHandler({
        path: '/rpc',
        handler: async () => new Response('duplicate'),
      }),
    ).toThrow('already mounted')
    expect(() =>
      host.mountFetchHandler({
        path: '/healthy',
        handler: async () => new Response('no'),
      }),
    ).toThrow('owned by the server host')
    expect(() => host.mountWebSocket({ path: '/healthy', hooks: {} })).toThrow(
      'owned by the server host',
    )
    host.mountWebSocket({ path: '/ws', hooks: {} })
    expect(() => host.mountWebSocket({ path: '/ws', hooks: {} })).toThrow(
      'already mounted',
    )

    await host.start()
    try {
      expect(() => host.mountWebSocket({ path: '/late', hooks: {} })).toThrow(
        'started server',
      )
    } finally {
      await host.stop()
    }
  })

  it('rejects start when the payload cap is below a handler requirement', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
      webSocket: { maxPayloadLength: 16384 },
    })
    host.mountWebSocket({
      path: '/ws',
      hooks: {},
      requirements: { minPayloadLength: 65536 + 1024 },
    })

    await expect(host.start()).rejects.toThrow(
      'The WebSocket handler on [/ws] requires maxPayloadLength >= 66560, ' +
        'but the host is configured with 16384',
    )
    // validation fired before binding: no socket to expose or leak
    expect(host.native[host.runtime]).toBeUndefined()
  })

  it('does not expose an unbound native app after a failed start', async () => {
    const host = createServerHost({ listen: {} } as any)

    await expect(host.start()).rejects.toThrow('Invalid listen parameters')
    expect(host.native[host.runtime]).toBeUndefined()
  })

  it('unmounts handlers while stopped', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    const unmount = host.mountFetchHandler({
      path: '/rpc',
      handler: async () => new Response('first'),
    })
    unmount()
    host.mountFetchHandler({
      path: '/rpc',
      handler: async () => new Response('second'),
    })
    const url = await host.start()
    try {
      await expect(
        fetch(`${url}/rpc`).then((response) => response.text()),
      ).resolves.toBe('second')
    } finally {
      await host.stop()
    }
  })
})
