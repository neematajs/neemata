import { BaseServerFormat, ProtocolFormats } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import type { NeemataHttpRequest } from '../../src/http/types.ts'
import { NeemataHttpHandler } from '../../src/http/server.ts'

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

async function createServer() {
  const format = new TestJsonFormat()
  const connection = {
    [Symbol.asyncDispose]: () => Promise.resolve(),
  }
  const onConnect = vi.fn(async () => connection)
  const resolve = vi.fn(async () => ({
    meta: { get: () => ['get', 'post'] },
  }))
  const onRpc = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
  const params = {
    onConnect,
    resolve,
    onRpc,
    onDisconnect: async () => {},
  }

  const server = new NeemataHttpHandler(params as any, {
    path: '/',
    formats: new ProtocolFormats([format]),
  })

  return { server, onConnect, resolve, onRpc }
}

const makeRequest = (
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
): NeemataHttpRequest => new Request(url, { method, headers })

describe('NeemataHttpHandler.handle', () => {
  describe('GET ?payload parsing', () => {
    it('responds 400 to malformed payload JSON', async () => {
      const { server, onRpc } = await createServer()

      const response = await server.handle(
        makeRequest('http://localhost/test?payload={bad', {
          accept: 'application/json',
        }),
      )

      expect(response.status).toBe(400)
      expect(onRpc).not.toHaveBeenCalled()
    })

    it('passes valid payload JSON to rpc handler', async () => {
      const { server, onRpc } = await createServer()

      const response = await server.handle(
        makeRequest(
          `http://localhost/test?payload=${encodeURIComponent('{"a":1}')}`,
          { accept: 'application/json' },
        ),
      )

      expect(response.status).toBe(200)
      expect(onRpc).toHaveBeenCalledOnce()
      expect(onRpc.mock.calls[0]![1]).toEqual({
        payload: { a: 1 },
        procedure: 'test',
      })
    })
  })

  describe('GET Accept negotiation', () => {
    it('keeps a supported Accept header', async () => {
      const { server } = await createServer()

      const response = await server.handle(
        makeRequest('http://localhost/test', { accept: 'application/json' }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/json')
    })

    it('falls back to the default format when Accept is not negotiable', async () => {
      const { server } = await createServer()

      const response = await server.handle(
        makeRequest('http://localhost/test', { accept: 'text/html' }),
      )

      // browser navigation sends HTML Accept headers; GET falls back to the
      // registry default instead of failing negotiation
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/json')
    })

    it('rejects a non-negotiable Accept for non-GET requests', async () => {
      const { server, onRpc } = await createServer()

      const response = await server.handle(
        makeRequest('http://localhost/test', { accept: 'text/html' }, 'POST'),
      )

      expect(response.status).toBe(406)
      expect(onRpc).not.toHaveBeenCalled()
    })
  })
})
