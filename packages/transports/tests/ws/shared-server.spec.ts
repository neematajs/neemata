import { Buffer } from 'node:buffer'

import { ClientMessageType, ServerMessageType } from '@nmtjs/protocol'
import { createServerTransport } from '@nmtjs/transports'
import { createServerHost } from '@nmtjs/transports/host/node'
import { neemataHttp } from '@nmtjs/transports/http'
import { neemataWebSocket } from '@nmtjs/transports/ws'
import { describe, expect, it, vi } from 'vitest'

function createParams() {
  return {
    onConnect: vi.fn(async () => ({
      id: `connection-${Math.random()}`,
      [Symbol.asyncDispose]: async () => {},
    })),
    onDisconnect: vi.fn(async () => {}),
    resolve: vi.fn(async () => ({ meta: new Map() })),
    onRpc: vi.fn(async () => ({ ok: true })),
  } as any
}

const openSocket = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('WebSocket failed to connect'))
  })

const encodePing = (nonce: number) => {
  const buffer = Buffer.alloc(5)
  buffer.writeUInt8(ClientMessageType.Ping, 0)
  buffer.writeUInt32LE(nonce, 1)
  return buffer
}

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

      const ws = await openSocket(
        `${url.replace('http', 'ws')}/ws?accept=application/json&content-type=application/json`,
      )
      // a protocol Ping flowing through the session engine and answered
      // with a Pong proves the frame loop is wired to this socket
      const pong = new Promise<Buffer>((resolve) => {
        ws.onmessage = (event) => resolve(Buffer.from(event.data))
      })
      ws.send(encodePing(7))
      const reply = await pong
      expect(reply.readUInt8(0)).toBe(ServerMessageType.Pong)
      expect(reply.readUInt32LE(1)).toBe(7)

      ws.close()
      await vi.waitFor(() => expect(params.onDisconnect).toHaveBeenCalled())
      expect(params.onConnect).toHaveBeenCalledTimes(2)
    } finally {
      await worker.stop()
    }

    await expect(fetch(`${url}/healthy`)).rejects.toThrow()
  })
})
