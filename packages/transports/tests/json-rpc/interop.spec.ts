import type { GatewayApi, GatewayApiCallOptions } from '@nmtjs/gateway'
import { Container, createLogger, Hooks } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'
import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'
import { createServerTransport } from '@nmtjs/transports/http-server'
import { createServerHost } from '@nmtjs/transports/http-server/node'
import { jsonRpc } from '@nmtjs/transports/json-rpc'
import jayson from 'jayson/promise/index.js'
import { JSONRPCClient } from 'json-rpc-2.0'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Interop: the JSON-RPC handler consumed by independent third-party client
 * implementations from the JS ecosystem — test-only dev dependencies, kept
 * out of the runtime entirely.
 */

type Handlers = Record<string, (options: GatewayApiCallOptions) => unknown>

const teardowns: Array<() => Promise<void>> = []
afterEach(async () => {
  while (teardowns.length) await teardowns.pop()!()
})

async function createHarness(handlers: Handlers) {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'interop')
  const container = new Container({ logger })

  const api: GatewayApi = {
    resolve: async ({ procedure }) => {
      if (!(procedure in handlers)) {
        throw new ProtocolError(ErrorCode.NotFound)
      }
      return { name: procedure, stream: false }
    },
    call: async (callOptions) => handlers[callOptions.procedure](callOptions),
  }

  const Server = createServerTransport({
    host: createServerHost,
    handlers: { rpc: jsonRpc() },
  })
  const transport = await Server.factory({
    listen: { port: 0, hostname: '127.0.0.1' },
    handlers: { rpc: { path: '/rpc' } },
  })

  const gateway = new Gateway({
    logger,
    container,
    hooks: new Hooks(),
    transports: { server: { transport, proxyable: Server.proxyable } },
    api,
  })

  const hosts = await gateway.start()
  const url = `${hosts[0].url}/rpc`

  teardowns.push(() => gateway.stop())

  return { url }
}

const HANDLERS: Handlers = {
  'math/add': ({ payload }) => {
    const [a, b] = payload as [number, number]
    return a + b
  },
  'users/get': ({ payload }) => ({ id: (payload as any).id, name: 'den' }),
  'users/fail': () => {
    throw new ProtocolError(ErrorCode.Forbidden, 'No access')
  },
  'audit/log': () => undefined,
}

describe('third-party client interop', () => {
  describe('jayson', () => {
    async function createClient() {
      const { url } = await createHarness(HANDLERS)
      const parsed = new URL(url)
      return jayson.Client.http({
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
      })
    }

    it('performs positional and named calls', async () => {
      const client = await createClient()

      const sum = await client.request('math.add', [2, 3])
      expect(sum).toMatchObject({ jsonrpc: '2.0', result: 5 })

      const user = await client.request('users.get', { id: 7 })
      expect(user.result).toEqual({ id: 7, name: 'den' })
    })

    it('receives spec error objects', async () => {
      const client = await createClient()
      const response = await client.request('users.fail', {})
      expect(response.error).toEqual({
        code: -32002,
        message: 'No access',
        data: { code: 'Forbidden' },
      })
    })

    it('performs batch requests', async () => {
      const client = await createClient()
      const batch = [
        client.request('math.add', [1, 1], undefined, false),
        client.request('math.add', [2, 2], undefined, false),
        client.request('missing.method', [], undefined, false),
      ]
      const responses = await client.request(batch)
      expect(responses).toHaveLength(3)
      const results = responses.map((r: any) => r.result ?? r.error.code)
      expect(results).toContain(2)
      expect(results).toContain(4)
      expect(results).toContain(-32601)
    })
  })

  describe('json-rpc-2.0', () => {
    async function createClient() {
      const { url } = await createHarness(HANDLERS)
      const client: JSONRPCClient = new JSONRPCClient(async (request) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        })
        if (response.status === 200) {
          client.receive(await response.json())
        }
      })
      return client
    }

    it('performs calls and receives typed results', async () => {
      const client = await createClient()
      await expect(client.request('math.add', [20, 22])).resolves.toBe(42)
      await expect(client.request('users.get', { id: 1 })).resolves.toEqual({
        id: 1,
        name: 'den',
      })
    })

    it('rejects on spec errors', async () => {
      const client = await createClient()
      await expect(client.request('users.fail', {})).rejects.toThrow(
        'No access',
      )
      await expect(client.request('missing.method', {})).rejects.toThrow()
    })

    it('sends notifications without expecting a response', async () => {
      const seen: unknown[] = []
      const { url } = await createHarness({
        'audit/log': ({ payload }) => {
          seen.push(payload)
          return undefined
        },
      })
      const client: JSONRPCClient = new JSONRPCClient(async (request) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        })
        if (response.status === 200) client.receive(await response.json())
      })

      client.notify('audit.log', { event: 'ping' })
      await vi.waitFor(() => expect(seen).toEqual([{ event: 'ping' }]))
    })
  })
})
