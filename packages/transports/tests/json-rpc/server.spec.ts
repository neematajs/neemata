import { ErrorCode } from '@nmtjs/protocol'
import {
  BaseServerFormat,
  ProtocolError,
  ProtocolFormats,
} from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import { JsonRpcHandler } from '../../src/json-rpc/server.ts'

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

type ServerOverrides = {
  resolve?: (...args: any[]) => Promise<any>
  onRpc?: (...args: any[]) => Promise<unknown>
  options?: Record<string, unknown>
  hostMaxBodySize?: number
}

function createServer(overrides: ServerOverrides = {}) {
  const format = new TestJsonFormat()
  const connection = {
    encoder: format,
    decoder: format,
    [Symbol.asyncDispose]: () => Promise.resolve(),
  }
  const onConnect = vi.fn(async () => connection)
  const resolve = vi.fn(
    overrides.resolve ??
      (async (_connection: unknown, procedure: string) => ({
        name: procedure,
        stream: false,
      })),
  )
  const onRpc = vi.fn(overrides.onRpc ?? (async () => ({ ok: true })))
  const params = {
    formats: new ProtocolFormats([format]),
    onConnect,
    resolve,
    onRpc,
    onDisconnect: async () => {},
    onMessage: async () => {},
  }

  const server = new JsonRpcHandler(
    params as any,
    { path: '/', ...overrides.options },
    overrides.hostMaxBodySize,
  )

  return { server, onConnect, resolve, onRpc }
}

const post = (body: unknown, raw = false) =>
  new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  })

const json = (response: Response) => response.json()

describe('JsonRpcHandler', () => {
  describe('transport level', () => {
    it('rejects non-POST requests with 405', async () => {
      const { server, onRpc } = createServer()
      const response = await server.handle(
        new Request('http://localhost/', { method: 'GET' }),
      )
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
      expect(onRpc).not.toHaveBeenCalled()
    })

    it('rejects oversized payloads with 413', async () => {
      const { server } = createServer({
        options: { maxRequestBodySize: 8 },
        hostMaxBodySize: 1024,
      })
      const response = await server.handle(
        post({ jsonrpc: '2.0', id: 1, method: 'a', params: { x: 'large' } }),
      )
      expect(response.status).toBe(413)
    })

    it('validates selection patterns at construction', () => {
      expect(() =>
        createServer({ options: { include: ['users/**'] } }),
      ).toThrow('Invalid include pattern')
      expect(() => createServer({ options: { maxBatchSize: 0 } })).toThrow(
        'maxBatchSize must be a positive integer',
      )
    })
  })

  describe('request validation', () => {
    it('answers malformed JSON with ParseError and null id', async () => {
      const { server } = createServer()
      const response = await server.handle(post('{bad', true))
      expect(response.status).toBe(200)
      expect(await json(response)).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      })
    })

    it('answers empty body with ParseError', async () => {
      const { server } = createServer()
      const response = await server.handle(post('', true))
      expect((await json(response)).error.code).toBe(-32700)
    })

    it.each([
      [42],
      [{ jsonrpc: '1.0', id: 1, method: 'a' }],
      [{ jsonrpc: '2.0', id: 1 }],
      [{ jsonrpc: '2.0', id: 1, method: 5 }],
    ])('answers invalid request %j with InvalidRequest', async (body) => {
      const { server } = createServer()
      const response = await server.handle(post(body))
      const parsed = await json(response)
      expect(parsed.error.code).toBe(-32600)
    })

    it('answers invalid id type with InvalidRequest and null id', async () => {
      const { server } = createServer()
      const response = await server.handle(
        post({ jsonrpc: '2.0', id: {}, method: 'a' }),
      )
      const parsed = await json(response)
      expect(parsed).toMatchObject({ id: null, error: { code: -32600 } })
    })

    it('answers primitive params with InvalidParams', async () => {
      const { server, onRpc } = createServer()
      const response = await server.handle(
        post({ jsonrpc: '2.0', id: 1, method: 'a', params: 'nope' }),
      )
      expect((await json(response)).error.code).toBe(-32602)
      expect(onRpc).not.toHaveBeenCalled()
    })
  })

  describe('method resolution', () => {
    it('transforms dotted methods into native names', async () => {
      const { server, resolve, onRpc } = createServer()
      const response = await server.handle(
        post({
          jsonrpc: '2.0',
          id: 'call-1',
          method: 'users.organizations.list',
          params: { page: 1 },
        }),
      )

      expect(await json(response)).toEqual({
        jsonrpc: '2.0',
        id: 'call-1',
        result: { ok: true },
      })
      expect(resolve).toHaveBeenCalledWith(
        expect.anything(),
        'users/organizations/list',
      )
      expect(onRpc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          procedure: 'users/organizations/list',
          payload: { page: 1 },
        }),
        expect.anything(),
      )
    })

    it.each(['users/create', 'users..create', '.users', 'users.'])(
      'rejects malformed method %j with MethodNotFound',
      async (method) => {
        const { server, resolve } = createServer()
        const response = await server.handle(
          post({ jsonrpc: '2.0', id: 1, method }),
        )
        expect((await json(response)).error.code).toBe(-32601)
        expect(resolve).not.toHaveBeenCalled()
      },
    )

    it('answers unknown procedures with MethodNotFound', async () => {
      const { server } = createServer({
        resolve: async () => {
          throw new ProtocolError(ErrorCode.NotFound)
        },
      })
      const response = await server.handle(
        post({ jsonrpc: '2.0', id: 1, method: 'missing' }),
      )
      expect((await json(response)).error.code).toBe(-32601)
    })

    it('hides stream procedures behind MethodNotFound', async () => {
      const { server, onRpc } = createServer({
        resolve: async (_c: unknown, procedure: string) => ({
          name: procedure,
          stream: true,
        }),
      })
      const response = await server.handle(
        post({ jsonrpc: '2.0', id: 1, method: 'ticks' }),
      )
      expect((await json(response)).error.code).toBe(-32601)
      expect(onRpc).not.toHaveBeenCalled()
    })

    it('applies include and exclude selection on native names', async () => {
      const { server, onRpc } = createServer({
        options: { include: ['users/*'], exclude: ['users/internal'] },
      })

      const allowed = await server.handle(
        post({ jsonrpc: '2.0', id: 1, method: 'users.create' }),
      )
      expect((await json(allowed)).result).toEqual({ ok: true })

      const excluded = await server.handle(
        post({ jsonrpc: '2.0', id: 2, method: 'users.internal' }),
      )
      expect((await json(excluded)).error.code).toBe(-32601)

      const outside = await server.handle(
        post({ jsonrpc: '2.0', id: 3, method: 'billing.charge' }),
      )
      expect((await json(outside)).error.code).toBe(-32601)

      expect(onRpc).toHaveBeenCalledTimes(1)
    })
  })

  describe('results and errors', () => {
    it('answers void results with null', async () => {
      const { server } = createServer({ onRpc: async () => undefined })
      const response = await server.handle(
        post({ jsonrpc: '2.0', id: 7, method: 'fire' }),
      )
      expect(await json(response)).toEqual({
        jsonrpc: '2.0',
        id: 7,
        result: null,
      })
    })

    it('maps validation errors to InvalidParams with the native code', async () => {
      const { server } = createServer({
        onRpc: async () => {
          throw new ProtocolError(ErrorCode.ValidationError, 'Bad input', {
            field: 'email',
          })
        },
      })
      const response = await server.handle(
        post({ jsonrpc: '2.0', id: 1, method: 'users.create' }),
      )
      expect(await json(response)).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32602,
          message: 'Bad input',
          data: { code: 'ValidationError', data: { field: 'email' } },
        },
      })
    })

    it('does not leak unknown error details', async () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      const { server } = createServer({
        onRpc: async () => {
          throw new Error('secret database url')
        },
      })
      const response = await server.handle(
        post({ jsonrpc: '2.0', id: 1, method: 'a' }),
      )
      expect(await json(response)).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: 'Internal error' },
      })
      consoleError.mockRestore()
    })

    it('rejects results that are not representable in JSON-RPC', async () => {
      const { server } = createServer({
        onRpc: async () =>
          (async function* () {
            yield 1
          })(),
      })
      const response = await server.handle(
        post({ jsonrpc: '2.0', id: 1, method: 'a' }),
      )
      expect((await json(response)).error.code).toBe(-32603)
    })
  })

  describe('notifications', () => {
    it('executes notifications and answers 204', async () => {
      const { server, onRpc } = createServer()
      const response = await server.handle(
        post({ jsonrpc: '2.0', method: 'audit.log', params: { ev: 1 } }),
      )
      expect(response.status).toBe(204)
      expect(onRpc).toHaveBeenCalledTimes(1)
    })

    it('swallows notification errors', async () => {
      const { server } = createServer({
        onRpc: async () => {
          throw new ProtocolError(ErrorCode.InternalServerError)
        },
      })
      const response = await server.handle(
        post({ jsonrpc: '2.0', method: 'audit.log' }),
      )
      expect(response.status).toBe(204)
    })
  })

  describe('batches', () => {
    it('answers an empty batch with InvalidRequest', async () => {
      const { server } = createServer()
      const response = await server.handle(post([]))
      expect((await json(response)).error.code).toBe(-32600)
    })

    it('enforces maxBatchSize', async () => {
      const { server, onRpc } = createServer({ options: { maxBatchSize: 2 } })
      const response = await server.handle(
        post([
          { jsonrpc: '2.0', id: 1, method: 'a' },
          { jsonrpc: '2.0', id: 2, method: 'b' },
          { jsonrpc: '2.0', id: 3, method: 'c' },
        ]),
      )
      const parsed = await json(response)
      expect(parsed.error.code).toBe(-32600)
      expect(parsed.error.message).toContain('limit of 2')
      expect(onRpc).not.toHaveBeenCalled()
    })

    it('processes mixed batches preserving ids and omitting notifications', async () => {
      const { server } = createServer({
        onRpc: async (_c: unknown, rpc: { procedure: string }) => {
          if (rpc.procedure === 'boom') {
            throw new ProtocolError(ErrorCode.Forbidden, 'No access')
          }
          return { echo: rpc.procedure }
        },
      })

      const response = await server.handle(
        post([
          { jsonrpc: '2.0', id: 1, method: 'users.get' },
          { jsonrpc: '2.0', method: 'audit.log' },
          { jsonrpc: '2.0', id: 2, method: 'boom' },
          { bad: true },
        ]),
      )

      const parsed = await json(response)
      expect(parsed).toHaveLength(3)
      expect(parsed).toContainEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { echo: 'users/get' },
      })
      expect(parsed).toContainEqual({
        jsonrpc: '2.0',
        id: 2,
        error: {
          code: -32002,
          message: 'No access',
          data: { code: 'Forbidden' },
        },
      })
      expect(parsed).toContainEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      })
    })

    it('answers 204 for an all-notification batch', async () => {
      const { server, onRpc } = createServer()
      const response = await server.handle(
        post([
          { jsonrpc: '2.0', method: 'a' },
          { jsonrpc: '2.0', method: 'b' },
        ]),
      )
      expect(response.status).toBe(204)
      expect(onRpc).toHaveBeenCalledTimes(2)
    })
  })
})
