import type { GatewayApi } from '@nmtjs/gateway'
import { Container, createLogger, Hooks } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'
import { createServerTransport } from '@nmtjs/transports/http-server'
import { createServerHost } from '@nmtjs/transports/http-server/node'
import { jsonRpc } from '@nmtjs/transports/json-rpc'
import { bench, describe } from 'vitest'

const requestsPerSample = 50
const benchmarkOptions = {
  iterations: 600,
  time: 0,
  warmupIterations: 100,
  warmupTime: 0,
}
const requestBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'benchmark.echo',
  params: { message: 'loopback' },
})

describe('JSON-RPC HTTP loopback', () => {
  let gateway: Gateway | undefined
  let url = ''

  async function setup() {
    if (gateway) return

    const logger = createLogger(
      { pinoOptions: { enabled: false } },
      'json-rpc-benchmark',
    )
    const container = new Container({ logger })
    const api: GatewayApi = {
      resolve: async ({ procedure }) => ({ name: procedure, stream: false }),
      call: async ({ payload }) => payload,
    }
    const Server = createServerTransport({
      host: createServerHost,
      handlers: { rpc: jsonRpc() },
    })
    const transport = await Server.factory({
      listen: { port: 0, hostname: '127.0.0.1' },
      handlers: { rpc: { path: '/rpc' } },
    })

    try {
      gateway = new Gateway({
        logger,
        container,
        hooks: new Hooks(),
        transports: { server: { transport, proxyable: Server.proxyable } },
        api,
      })
      const [host] = await gateway.start()
      url = `${host!.url}/rpc`

      const response = await call()
      if (!response.ok) {
        throw new Error(`JSON-RPC benchmark warmup failed: ${response.status}`)
      }
      await response.arrayBuffer()
    } catch (error) {
      await teardown()
      throw error
    }
  }

  async function teardown() {
    const runningGateway = gateway
    gateway = undefined
    url = ''
    await runningGateway?.stop()
  }

  bench(
    `round-trips ${requestsPerSample} sequential calls`,
    async () => {
      for (let index = 0; index < requestsPerSample; index++) {
        const response = await call()
        await response.arrayBuffer()
      }
    },
    {
      ...benchmarkOptions,
      setup,
      teardown: (_task, mode) => {
        if (mode === 'run') return teardown()
      },
    },
  )

  function call() {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    })
  }
})
