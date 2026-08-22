import type { AuthInfo } from '@modelcontextprotocol/server'
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server'
import { BaseServerFormat } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import type { McpToolConfig } from '../../src/mcp/types.ts'
import { McpHandler, mcpAuthInfo } from '../../src/mcp/server.ts'

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
  const format = new TestJsonFormat()
  const connection = {
    encoder: format,
    decoder: format,
    [Symbol.asyncDispose]: vi.fn(() => Promise.resolve()),
  }
  const onConnect = vi.fn(async () => connection)
  const params = {
    onConnect,
    resolve: vi.fn(),
    onRpc: vi.fn(),
    onDisconnect: async () => {},
  }

  const server = new McpHandler(params as any, {
    path: '/mcp',
    serverInfo: { name: 'test-app', version: '1.0.0' },
    tools: overrides.tools ?? [{ procedure: 'users/create' }],
    auth: overrides.auth,
  })

  return { server, connection, onConnect }
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
