import { BaseServerFormat, ProtocolFormats } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import type {
  HttpAdapterServer,
  HttpTransportServerRequest,
} from '../src/types.ts'
import { HttpTransportServer } from '../src/server.ts'

class TestJsonFormat extends BaseServerFormat {
  accept = ['application/json']
  contentType = 'application/json'

  encode(data: unknown): ArrayBufferView {
    return new TextEncoder().encode(JSON.stringify(data))
  }

  encodeRPC(data: unknown): ArrayBufferView {
    return this.encode(data)
  }

  encodeBlob(): unknown {
    return null
  }

  decode(buffer: ArrayBufferView): any {
    return JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      ),
    )
  }

  decodeRPC(buffer: ArrayBufferView): any {
    return this.decode(buffer)
  }
}

const adapterFactory = (): HttpAdapterServer => ({
  runtime: {},
  start: () => 'http://127.0.0.1:0',
  stop: () => {},
})

async function createServer() {
  const format = new TestJsonFormat()
  const connection = {
    encoder: format,
    decoder: format,
    [Symbol.asyncDispose]: () => Promise.resolve(),
  }
  const onConnect = vi.fn(async () => connection)
  const resolve = vi.fn(async () => ({
    meta: { get: () => ['get', 'post'] },
  }))
  const onRpc = vi.fn(async () => ({ ok: true }))
  const params = {
    formats: new ProtocolFormats([format]),
    onConnect,
    resolve,
    onRpc,
    onDisconnect: async () => {},
    onMessage: async () => {},
  }

  const server = new HttpTransportServer(adapterFactory, {
    listen: { port: 0 },
  })
  await server.start(params as any)

  return { server, onConnect, resolve, onRpc }
}

const makeRequest = (
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
): HttpTransportServerRequest => ({
  url: new URL(url),
  method,
  headers: new Headers(headers),
})

describe('HttpTransportServer.httpHandler', () => {
  describe('GET ?payload parsing', () => {
    it('responds 400 to malformed payload JSON', async () => {
      const { server, onRpc } = await createServer()

      const response = await server.httpHandler(
        makeRequest('http://localhost/test?payload={bad', {
          accept: 'application/json',
        }),
        null,
        new AbortController().signal,
      )

      expect(response.status).toBe(400)
      expect(onRpc).not.toHaveBeenCalled()
    })

    it('passes valid payload JSON to rpc handler', async () => {
      const { server, onRpc } = await createServer()

      const response = await server.httpHandler(
        makeRequest(
          `http://localhost/test?payload=${encodeURIComponent('{"a":1}')}`,
          { accept: 'application/json' },
        ),
        null,
        new AbortController().signal,
      )

      expect(response.status).toBe(200)
      expect(onRpc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ payload: { a: 1 } }),
        expect.anything(),
        expect.anything(),
      )
    })
  })

  describe('GET Accept negotiation', () => {
    it('keeps a supported Accept header', async () => {
      const { server, onConnect } = await createServer()

      await server.httpHandler(
        makeRequest('http://localhost/test', { accept: 'application/json' }),
        null,
        new AbortController().signal,
      )

      expect(onConnect).toHaveBeenCalledWith(
        expect.objectContaining({ accept: 'application/json' }),
      )
    })

    it('falls back to */* when Accept is not negotiable', async () => {
      const { server, onConnect } = await createServer()

      await server.httpHandler(
        makeRequest('http://localhost/test', { accept: 'text/html' }),
        null,
        new AbortController().signal,
      )

      expect(onConnect).toHaveBeenCalledWith(
        expect.objectContaining({ accept: '*/*' }),
      )
    })

    it('keeps non-negotiable Accept for non-GET requests', async () => {
      const { server, onConnect } = await createServer()

      await server.httpHandler(
        makeRequest('http://localhost/test', { accept: 'text/html' }, 'POST'),
        null,
        new AbortController().signal,
      )

      expect(onConnect).toHaveBeenCalledWith(
        expect.objectContaining({ accept: 'text/html' }),
      )
    })
  })
})
