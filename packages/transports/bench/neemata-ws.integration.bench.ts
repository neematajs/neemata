import type { GatewayApi } from '@nmtjs/gateway'
import { RuntimeClient } from '@nmtjs/client'
import { WsTransportFactory } from '@nmtjs/client/ws'
import { c } from '@nmtjs/contract'
import { Container, createLogger, Hooks } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'
import { ProtocolVersion } from '@nmtjs/protocol'
import { JsonCodec as ClientJsonCodec } from '@nmtjs/protocol/json/client'
import { JsonCodec as ServerJsonCodec } from '@nmtjs/protocol/json/server'
import { ProtocolCodecRegistry } from '@nmtjs/protocol/server'
import { createServerTransport } from '@nmtjs/transports/http-server'
import { createServerHost } from '@nmtjs/transports/http-server/node'
import { neemataWebSocket } from '@nmtjs/transports/neemata/ws'
import { t } from '@nmtjs/type'
import { bench, describe } from 'vitest'

const callsPerSample = 100
const input = Object.freeze({ message: 'loopback' })
const contract = c.router({
  routes: {
    echo: c.procedure({
      input: t.object({ message: t.string() }),
      output: t.object({ message: t.string() }),
    }),
  },
})

const createClient = (url: string) =>
  new RuntimeClient(
    {
      contract,
      protocol: ProtocolVersion.v1,
      codec: new ClientJsonCodec(),
    },
    WsTransportFactory,
    { url },
  )

describe('Neemata WebSocket loopback', () => {
  let gateway: Gateway | undefined
  let client: ReturnType<typeof createClient> | undefined

  async function setup() {
    if (gateway) return

    const logger = createLogger(
      { pinoOptions: { enabled: false } },
      'websocket-benchmark',
    )
    const container = new Container({ logger })
    const api: GatewayApi = {
      resolve: async ({ procedure }) => ({ name: procedure, stream: false }),
      call: async ({ payload }) => payload,
    }
    const Server = createServerTransport({
      host: createServerHost,
      handlers: {
        ws: neemataWebSocket({
          codecs: new ProtocolCodecRegistry([new ServerJsonCodec()]),
        }),
      },
    })
    const transport = await Server.factory({
      listen: { port: 0, hostname: '127.0.0.1' },
      handlers: { ws: { path: '/', heartbeat: false } },
    })

    try {
      gateway = new Gateway({
        logger,
        container,
        hooks: new Hooks(),
        transports: { ws: { transport, proxyable: Server.proxyable } },
        api,
      })
      const [host] = await gateway.start()
      const runningClient = createClient(host!.url)
      client = runningClient
      await runningClient.connect()

      const response = await runningClient.call.echo(input)
      if (response.message !== input.message) {
        throw new Error('WebSocket benchmark warmup returned invalid data')
      }
    } catch (error) {
      await teardown()
      throw error
    }
  }

  async function teardown() {
    const runningClient = client
    const runningGateway = gateway
    client = undefined
    gateway = undefined
    await runningClient?.disconnect().catch(() => {})
    runningClient?.dispose()
    await runningGateway?.stop()
  }

  bench(
    `round-trips ${callsPerSample} sequential unary calls`,
    async () => {
      for (let index = 0; index < callsPerSample; index++) {
        await client!.call.echo(input)
      }
    },
    {
      iterations: 60,
      time: 0,
      warmupIterations: 10,
      warmupTime: 0,
      setup,
      teardown: (_task, mode) => {
        if (mode === 'run') return teardown()
      },
    },
  )
})
