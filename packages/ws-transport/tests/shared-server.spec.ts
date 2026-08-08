import { neemataHttp } from '@nmtjs/http-transport'
import { ConnectionType } from '@nmtjs/protocol'
import { createServerTransport } from '@nmtjs/server-host'
import { createServerHost } from '@nmtjs/server-host/node'
import { describe, expect, it, vi } from 'vitest'

import { neemataWebSocket } from '../src/server.ts'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function createParams() {
  return {
    formats: {
      supportsDecoder: (contentType: string) =>
        contentType.startsWith('application/json'),
      supportsEncoder: () => true,
    },
    onConnect: vi.fn(async ({ type }) => ({
      id:
        type === ConnectionType.Bidirectional
          ? 'ws-connection'
          : 'http-connection',
      encoder: {
        contentType: 'application/json',
        encode: (data: unknown) =>
          textEncoder.encode(JSON.stringify(data ?? null)),
      },
      decoder: {
        decode: (buffer: Uint8Array) => JSON.parse(textDecoder.decode(buffer)),
      },
      [Symbol.asyncDispose]: async () => {},
    })),
    onDisconnect: vi.fn(async () => {}),
    onMessage: vi.fn(async () => {}),
    resolve: vi.fn(async () => ({ meta: new Map() })),
    onRpc: vi.fn(async () => ({ ok: true })),
  } as any
}

const openSocket = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('WebSocket failed to connect'))
  })

describe('http + ws transports on a shared server', () => {
  it('serves both protocols through one host-owned transport', async () => {
    // both handlers re-export the gateway's connectionData token; the shared
    // key must not trip the injectable collision guard at creation
    const ServerTransport = createServerTransport({
      host: createServerHost,
      handlers: {
        http: neemataHttp(),
        ws: neemataWebSocket(),
      },
    })
    const worker = await ServerTransport.factory({
      listen: { port: 0, hostname: '127.0.0.1' },
      handlers: { http: { path: '/api' }, ws: { path: '/ws' } },
    })
    const params = createParams()
    const url = await worker.start(params)

    try {
      const response = await fetch(`${url}/api/procedure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"n":1}',
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(params.onRpc).toHaveBeenCalledOnce()
      expect(params.resolve).toHaveBeenCalledWith(
        expect.anything(),
        'procedure',
      )
      expect((await fetch(`${url}/procedure`)).status).toBe(404)

      const ws = await openSocket(`${url.replace('http', 'ws')}/ws`)
      ws.send(new Uint8Array([1, 2, 3]))
      await vi.waitFor(() => expect(params.onMessage).toHaveBeenCalled())
      const { data } = params.onMessage.mock.calls[0][0]
      expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3]))
      ws.close()
      await vi.waitFor(() => expect(params.onDisconnect).toHaveBeenCalled())
      expect(params.onConnect).toHaveBeenCalledTimes(2)
    } finally {
      await worker.stop(params)
    }

    await expect(fetch(`${url}/healthy`)).rejects.toThrow()
  })
})
