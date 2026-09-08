import type { AuthInfo } from '@modelcontextprotocol/server'
import type { TransportWorkerParams } from '@nmtjs/gateway'
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  OAuthError,
  OAuthErrorCode,
  PROTOCOL_VERSION_META_KEY,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/server'
import { BaseServerCodec } from '@nmtjs/protocol/server'
import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

import type { McpToolConfig } from '../../src/mcp/types.ts'
import { McpHandler, mcpAuthInfo } from '../../src/mcp/server.ts'

class TestJsonCodec extends BaseServerCodec {
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

const AUTH_INFO: AuthInfo = {
  token: 'valid-token',
  clientId: 'agent-1',
  scopes: ['mcp:tools'],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
}

type Overrides = {
  tools?: McpToolConfig[]
  auth?: any
}

function createServer(overrides: Overrides = {}) {
  const codec = new TestJsonCodec()
  const connection = {
    encoder: codec,
    decoder: codec,
    [Symbol.asyncDispose]: vi.fn(() => Promise.resolve()),
  }
  const onConnect = vi.fn(async () => connection)
  const params = {
    onConnect,
    resolve: vi.fn(),
    onRpc: vi.fn<TransportWorkerParams['onRpc']>(),
    onDisconnect: async () => {},
  }

  const server = new McpHandler(params as any, {
    path: '/mcp',
    serverInfo: { name: 'test-app', version: '1.0.0' },
    tools: overrides.tools ?? [{ procedure: 'users/create' }],
    auth: overrides.auth,
  })

  return { server, connection, onConnect, params }
}

const verifier = {
  verifyAccessToken: async (token: string): Promise<AuthInfo> => {
    if (token !== 'valid-token') {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown token')
    }
    return AUTH_INFO
  },
}

describe('McpHandler', () => {
  it('aborts the in-flight RPC when the HTTP request is cancelled', async () => {
    const { server, connection, params } = createServer()
    params.resolve.mockResolvedValue({
      stream: false,
      procedure: {
        contract: {
          input: t.object({ name: t.string() }),
          description: 'Create a user',
        },
      },
    })
    const started = Promise.withResolvers<AbortSignal>()
    const completed = Promise.withResolvers<void>()
    params.onRpc.mockImplementation(async (_connection, _rpc, signal) => {
      started.resolve(signal)
      await completed.promise
      return { id: 42 }
    })

    const controller = new AbortController()
    const response = server.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-method': 'tools/call',
          'mcp-name': 'users_create',
        },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'users_create',
            arguments: { name: 'den' },
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
              [CLIENT_INFO_META_KEY]: { name: 'test', version: '1.0.0' },
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      }),
    )
    try {
      const signal = await started.promise
      expect(params.onRpc).toHaveBeenCalledExactlyOnceWith(
        connection,
        { procedure: 'users/create', payload: { name: 'den' } },
        signal,
      )
      expect(signal.aborted).toBe(false)
      controller.abort()
      expect(signal.aborted).toBe(true)
      expect(signal.reason).toBeInstanceOf(SdkError)
      expect(signal.reason.code).toBe(SdkErrorCode.ConnectionClosed)
    } finally {
      controller.abort()
      completed.resolve()
      expect((await response).status).toBe(499)
    }
    expect(connection[Symbol.asyncDispose]).toHaveBeenCalledOnce()
  })

  describe('construction', () => {
    it('derives tool names and rejects duplicates', () => {
      expect(() =>
        createServer({
          tools: [{ procedure: 'users/create' }, { procedure: 'users/create' }],
        }),
      ).toThrow('Duplicate MCP tool name "users_create"')

      expect(() =>
        createServer({ tools: [{ procedure: 'users/create', name: 'x y' }] }),
      ).toThrow('Invalid MCP tool name "x y"')
    })
  })

  describe('auth gate', () => {
    it('challenges missing tokens with 401 and WWW-Authenticate', async () => {
      const { server, onConnect } = createServer({
        auth: {
          verifier,
          resourceMetadataUrl:
            'https://api.example.com/.well-known/oauth-protected-resource',
        },
      })
      const response = await server.handle(
        new Request('http://localhost/mcp', { method: 'POST', body: '{}' }),
      )
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toContain('Bearer')
      expect(response.headers.get('www-authenticate')).toContain(
        'resource_metadata',
      )
      expect(onConnect).not.toHaveBeenCalled()
    })

    it('challenges invalid tokens with 401', async () => {
      const { server, onConnect } = createServer({ auth: { verifier } })
      const response = await server.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { authorization: 'Bearer nope' },
          body: '{}',
        }),
      )
      expect(response.status).toBe(401)
      expect(onConnect).not.toHaveBeenCalled()
    })

    it('challenges missing scopes with 403 insufficient_scope', async () => {
      const { server } = createServer({
        auth: { verifier, requiredScopes: ['mcp:admin'] },
      })
      const response = await server.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { authorization: 'Bearer valid-token' },
          body: '{}',
        }),
      )
      expect(response.status).toBe(403)
      expect(response.headers.get('www-authenticate')).toContain(
        'insufficient_scope',
      )
    })

    it('provisions verified auth info into the connection scope', async () => {
      const { server, onConnect } = createServer({ auth: { verifier } })
      await server.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            authorization: 'Bearer valid-token',
            'content-type': 'application/json',
          },
          body: '{}',
        }),
      )
      expect(onConnect).toHaveBeenCalledTimes(1)
      const provisions = onConnect.mock.calls[0].slice(1) as any[]
      expect(provisions).toContainEqual(
        expect.objectContaining({ token: mcpAuthInfo, value: AUTH_INFO }),
      )
    })
  })
})
