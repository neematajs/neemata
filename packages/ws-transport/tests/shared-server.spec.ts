import { HttpTransport } from '@nmtjs/http-transport/node'
import { createServerHost } from '@nmtjs/server/node'
import { describe, expect, it, vi } from 'vitest'

import { WsTransport } from '../src/runtimes/node.ts'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function createHttpParams() {
  const connection = {
    id: 'http-connection',
    encoder: {
      contentType: 'application/json',
      encode: (data: unknown) =>
        textEncoder.encode(JSON.stringify(data ?? null)),
    },
    decoder: {
      decode: (buffer: Uint8Array) => JSON.parse(textDecoder.decode(buffer)),
    },
    [Symbol.asyncDispose]: async () => {},
  }
  return {
    formats: {
      supportsDecoder: (contentType: string) =>
        contentType.startsWith('application/json'),
      supportsEncoder: () => true,
    },
    onConnect: vi.fn(async () => connection),
    onDisconnect: vi.fn(async () => {}),
    onMessage: vi.fn(async () => {}),
    resolve: vi.fn(async () => ({ meta: new Map() })),
    onRpc: vi.fn(async () => ({ ok: true })),
  } as any
}

function createWsParams() {
  const connection = {
    id: 'ws-connection',
    [Symbol.asyncDispose]: async () => {},
  }
  return {
    formats: {},
    onConnect: vi.fn(async () => connection),
    onDisconnect: vi.fn(async () => {}),
    onMessage: vi.fn(async () => {}),
    resolve: vi.fn(),
    onRpc: vi.fn(),
  } as any
}

const openSocket = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('WebSocket failed to connect'))
  })

describe('http + ws transports on a shared server', () => {
  it('serves both transports from one listen address', async () => {
    const host = createServerHost({
      listen: { port: 0, hostname: '127.0.0.1' },
    })

    const httpParams = createHttpParams()
    const wsParams = createWsParams()

    const httpWorker = await HttpTransport.factory({ server: host })
    const wsWorker = await WsTransport.factory({ server: host })

    const httpUrl = await httpWorker.start(httpParams)
    const wsUrl = await wsWorker.start(wsParams)
    // both workers report the same bound address — exactly what the
    // gateway hands to the proxy for both upstream types
    expect(wsUrl).toBe(httpUrl)

    let httpStopped = false
    try {
      const response = await fetch(`${httpUrl}/procedure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"n":1}',
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(httpParams.onRpc).toHaveBeenCalledOnce()

      const ws = await openSocket(httpUrl.replace('http', 'ws'))
      expect(wsParams.onConnect).toHaveBeenCalledOnce()
      ws.send(new Uint8Array([1, 2, 3]))
      await vi.waitFor(() => expect(wsParams.onMessage).toHaveBeenCalled())
      const { data } = wsParams.onMessage.mock.calls[0][0]
      expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3]))
      ws.close()
      await vi.waitFor(() => expect(wsParams.onDisconnect).toHaveBeenCalled())

      // one worker stopping must not kill the other's socket
      await httpWorker.stop(httpParams)
      httpStopped = true
      const wsStillUp = await openSocket(httpUrl.replace('http', 'ws'))
      wsStillUp.close()
    } finally {
      // teardown must run even when the liveness probe above fails, or the
      // bound host leaks into the rest of the suite
      if (!httpStopped) await httpWorker.stop(httpParams)
      await wsWorker.stop(wsParams)
    }

    await expect(fetch(`${httpUrl}/healthy`)).rejects.toThrow()
  })
})
