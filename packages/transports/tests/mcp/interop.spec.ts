import type { AuthInfo } from '@modelcontextprotocol/server'
import type { GatewayApi, GatewayApiCallOptions } from '@nmtjs/gateway'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server'
import { Container, createLogger, Hooks } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'
import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'
import { createServerTransport } from '@nmtjs/transports/http-server'
import { createServerHost } from '@nmtjs/transports/http-server/node'
import { mcp } from '@nmtjs/transports/mcp'
import { t } from '@nmtjs/type'
import { afterEach, describe, expect, it } from 'vitest'

import type { McpAuthOptions } from '../../src/mcp/types.ts'

/**
 * Interop: the MCP handler (2026-07-28, SDK-backed) consumed by the official
 * @modelcontextprotocol/client v2 over streamable HTTP — test-only dev
 * dependencies, kept out of the runtime entirely.
 */

const CONTRACTS: Record<string, { input: any; description?: string }> = {
  'users/create': {
    input: t.object({ email: t.string(), name: t.string() }),
    description: 'Create a user account',
  },
  'system/health': {
    input: t.never(),
    description: 'Health check',
  },
}

type Handlers = Record<string, (options: GatewayApiCallOptions) => unknown>

const teardowns: Array<() => Promise<void>> = []
afterEach(async () => {
  while (teardowns.length) await teardowns.pop()!()
})

async function createHarness(handlers: Handlers, auth?: McpAuthOptions) {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'mcp')
  const container = new Container({ logger })

  const api: GatewayApi<any> = {
    resolve: async ({ procedure }) => {
      if (!(procedure in CONTRACTS)) {
        throw new ProtocolError(ErrorCode.NotFound)
      }
      return {
        name: procedure,
        stream: false,
        procedure: { contract: CONTRACTS[procedure] },
      }
    },
    call: async (callOptions) => handlers[callOptions.procedure](callOptions),
  }

  const Server = createServerTransport({
    host: createServerHost,
    handlers: { agents: mcp() },
  })
  const transport = await Server.factory({
    listen: { port: 0, hostname: '127.0.0.1' },
    handlers: {
      agents: {
        path: '/mcp',
        serverInfo: { name: 'neemata-test', version: '1.0.0' },
        instructions: 'Test tools for interop verification',
        tools: [
          { procedure: 'users/create' },
          { procedure: 'system/health', name: 'health_check' },
        ],
        auth,
      },
    },
  })

  const gateway = new Gateway({
    logger,
    container,
    hooks: new Hooks(),
    transports: { server: { transport, proxyable: Server.proxyable } },
    api,
  })

  const hosts = await gateway.start()
  const url = `${hosts[0].url}/mcp`

  teardowns.push(() => gateway.stop())

  return { url }
}

async function connectClient(url: string, requestInit?: RequestInit) {
  const client = new Client(
    { name: 'interop-test', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  )
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit,
  })
  await client.connect(transport)
  teardowns.push(async () => {
    await client.close().catch(() => {})
  })
  return client
}

describe('official MCP SDK v2 client interop (2026-07-28)', () => {
  it('lists tools with emitted schemas and descriptions', async () => {
    const { url } = await createHarness({})
    const client = await connectClient(url)

    const { tools } = await client.listTools()
    expect(tools).toHaveLength(2)

    const createUser = tools.find((tool) => tool.name === 'users_create')!
    expect(createUser.description).toBe('Create a user account')
    expect(createUser.inputSchema).toMatchObject({ type: 'object' })
    expect(createUser.inputSchema.required).toEqual(['email', 'name'])

    const health = tools.find((tool) => tool.name === 'health_check')!
    expect(health.inputSchema).toMatchObject({ type: 'object' })
  })

  it('calls tools and receives structured results', async () => {
    const { url } = await createHarness({
      'users/create': ({ payload }) => ({ id: 42, ...(payload as object) }),
    })
    const client = await connectClient(url)

    const result = await client.callTool({
      name: 'users_create',
      arguments: { email: 'a@b.c', name: 'den' },
    })

    expect(result.isError).toBe(false)
    expect(result.structuredContent).toEqual({
      id: 42,
      email: 'a@b.c',
      name: 'den',
    })
  })

  it('receives execution failures as tool errors, not protocol errors', async () => {
    const { url } = await createHarness({
      'users/create': () => {
        throw new ProtocolError(ErrorCode.ValidationError, 'Invalid email')
      },
    })
    const client = await connectClient(url)

    const result = await client.callTool({
      name: 'users_create',
      arguments: { email: 'nope', name: 'x' },
    })

    expect(result.isError).toBe(true)
    expect((result.content as any[])[0].text).toBe('Invalid email')
  })

  it('calls input-less tools', async () => {
    const { url } = await createHarness({
      'system/health': () => ({ healthy: true }),
    })
    const client = await connectClient(url)

    const result = await client.callTool({
      name: 'health_check',
      arguments: {},
    })
    expect(result.structuredContent).toEqual({ healthy: true })
  })

  it('rejects 2025-era session traffic (legacy: reject)', async () => {
    const { url } = await createHarness({})
    // an old-style initialize handshake POST without the modern _meta envelope
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'old-client', version: '0.0.0' },
        },
      }),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  describe('with bearer auth', () => {
    const AUTH_INFO: AuthInfo = {
      token: 'valid-token',
      clientId: 'agent-1',
      scopes: ['mcp:tools'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }
    const auth: McpAuthOptions = {
      verifier: {
        verifyAccessToken: async (token) => {
          if (token !== 'valid-token') {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown token')
          }
          return AUTH_INFO
        },
      },
      requiredScopes: ['mcp:tools'],
    }

    it('rejects unauthenticated clients with a 401 challenge', async () => {
      const { url } = await createHarness({}, auth)
      const client = new Client(
        { name: 'anon', version: '0.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )
      const transport = new StreamableHTTPClientTransport(new URL(url))
      await expect(client.connect(transport)).rejects.toThrow()
    })

    it('serves authenticated clients', async () => {
      const { url } = await createHarness(
        { 'system/health': () => ({ healthy: true }) },
        auth,
      )
      const client = await connectClient(url, {
        headers: { authorization: 'Bearer valid-token' },
      })

      const result = await client.callTool({
        name: 'health_check',
        arguments: {},
      })
      expect(result.structuredContent).toEqual({ healthy: true })
    })
  })
})
