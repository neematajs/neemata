import type { GatewayApi, GatewayApiCallOptions } from '@nmtjs/gateway'
import { Container, createLogger, Hooks } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'
import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'
import { createServerTransport } from '@nmtjs/transports'
import { createServerHost } from '@nmtjs/transports/host/node'
import { jsonRpc } from '@nmtjs/transports/json-rpc'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * End-to-end: a real Gateway behind the real uWS host with the JSON-RPC
 * handler mounted, consumed by plain fetch — the "stock client" contract.
 */

type Handlers = Record<string, (options: GatewayApiCallOptions) => unknown>

const teardowns: Array<() => Promise<void>> = []
afterEach(async () => {
  while (teardowns.length) await teardowns.pop()!()
})

async function createHarness(handlers: Handlers) {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'jsonrpc')
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
    handlers: { rpc: { path: '/rpc', maxBatchSize: 3 } },
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

const call = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('JSON-RPC over a real host', () => {
  it('round-trips a single call through the gateway pipeline', async () => {
    const { url } = await createHarness({
      'users/create': ({ payload }) => ({ id: 1, ...(payload as object) }),
    })

    const response = await call(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'users.create',
      params: { email: 'a@b.c' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { id: 1, email: 'a@b.c' },
    })
  })

  it('handles batches with notifications and errors', async () => {
    const seen: string[] = []
    const { url } = await createHarness({
      'users/get': () => ({ name: 'den' }),
      'audit/log': ({ payload }) => {
        seen.push(String((payload as any).event))
        return undefined
      },
    })

    const response = await call(url, [
      { jsonrpc: '2.0', id: 'a', method: 'users.get' },
      { jsonrpc: '2.0', method: 'audit.log', params: { event: 'ping' } },
      { jsonrpc: '2.0', id: 'b', method: 'nope.nope' },
    ])

    const parsed = await response.json()
    expect(parsed).toHaveLength(2)
    expect(parsed).toContainEqual({
      jsonrpc: '2.0',
      id: 'a',
      result: { name: 'den' },
    })
    expect(parsed).toContainEqual(
      expect.objectContaining({
        id: 'b',
        error: expect.objectContaining({ code: -32601 }),
      }),
    )
    expect(seen).toEqual(['ping'])
  })

  it('enforces the configured batch limit', async () => {
    const { url } = await createHarness({ a: () => 1 })
    const response = await call(
      url,
      Array.from({ length: 4 }, (_, i) => ({
        jsonrpc: '2.0',
        id: i,
        method: 'a',
      })),
    )
    const parsed = await response.json()
    expect(parsed.error.code).toBe(-32600)
  })

  it('answers a notification-only request with 204', async () => {
    const { url } = await createHarness({ 'audit/log': () => undefined })
    const response = await call(url, {
      jsonrpc: '2.0',
      method: 'audit.log',
    })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })
})
