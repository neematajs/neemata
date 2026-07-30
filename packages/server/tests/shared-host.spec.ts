import { defineHooks } from 'crossws'
import { describe, expect, it } from 'vitest'

import { createServerHost } from '../src/runtimes/node.ts'

const openSocket = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('WebSocket failed to connect'))
  })

const echoHooks = () =>
  defineHooks({
    message(peer, message) {
      peer.send(`echo:${message.text()}`)
    },
  })

describe('shared node server host', () => {
  it('serves HTTP, WebSocket and /healthy on a single socket', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    host.setFetchHandler(
      async (request) => new Response(`hello:${request.url.pathname}`),
    )
    host.setWebSocket({ hooks: echoHooks() })

    const url = await host.start()
    try {
      const response = await fetch(`${url}/route`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('hello:/route')

      const healthy = await fetch(`${url}/healthy`)
      expect(healthy.status).toBe(200)

      const ws = await openSocket(url.replace('http', 'ws'))
      const reply = new Promise<string>((resolve) => {
        ws.onmessage = (event) => resolve(String(event.data))
      })
      ws.send('ping')
      expect(await reply).toBe('echo:ping')
      ws.close()
    } finally {
      await host.stop()
    }
  })

  it('closes the socket only after the last registrant stops', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    host.setFetchHandler(async () => new Response('ok'))
    host.setWebSocket({ hooks: echoHooks() })

    // two registrants claim the same bound socket
    const first = await host.start()
    const second = await host.start()
    expect(second).toBe(first)

    await host.stop()
    // one registrant remains: still serving
    const response = await fetch(`${first}/healthy`)
    expect(response.status).toBe(200)

    await host.stop()
    await expect(fetch(`${first}/healthy`)).rejects.toThrow()
  })

  it('rebinds after a full stop', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    host.setFetchHandler(async () => new Response('ok'))

    const first = await host.start()
    await host.stop()

    const second = await host.start()
    try {
      const response = await fetch(`${second}/healthy`)
      expect(response.status).toBe(200)
    } finally {
      await host.stop()
    }
    // port 0 means the rebound socket may live elsewhere; only liveness
    // of the second URL matters
    expect(second).not.toBe('')
    expect(first).not.toBe('')
  })

  it('rejects upgrade requests without a WebSocket tenant', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    host.setFetchHandler(async () => new Response('ok'))

    const url = await host.start()
    try {
      await expect(openSocket(url.replace('http', 'ws'))).rejects.toThrow()
      // plain HTTP is unaffected
      const response = await fetch(url)
      expect(response.status).toBe(200)
    } finally {
      await host.stop()
    }
  })

  it('serves 404 for plain HTTP without a fetch tenant', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    host.setWebSocket({ hooks: echoHooks() })

    const url = await host.start()
    try {
      const response = await fetch(`${url}/anything`)
      expect(response.status).toBe(404)
      // health stays host-owned
      const healthy = await fetch(`${url}/healthy`)
      expect(healthy.status).toBe(200)
    } finally {
      await host.stop()
    }
  })

  it('rejects duplicate registrations and registration after start', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })
    host.setFetchHandler(async () => new Response('ok'))
    expect(() => host.setFetchHandler(async () => new Response('no'))).toThrow(
      'already registered',
    )

    await host.start()
    try {
      expect(() => host.setWebSocket({ hooks: echoHooks() })).toThrow(
        'started server',
      )
    } finally {
      await host.stop()
    }
  })
})
