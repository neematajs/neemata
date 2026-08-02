import type {
  GatewayApi,
  GatewayResolvedProcedure,
  TransportWorker,
} from '@nmtjs/gateway'
import type { NeemRuntimeUpstream, NeemRuntimeWorkerContext } from '@nmtjs/neem'
import type { ConnectionType } from '@nmtjs/protocol'
import { Container, createLogger, Hooks } from '@nmtjs/core'
import { Gateway, ProxyableTransportType } from '@nmtjs/gateway'
import { HttpTransport } from '@nmtjs/http-transport/node'
import { JsonFormat } from '@nmtjs/json-format/server'
import { defineRuntimeWorker } from '@nmtjs/neem'
import { ProtocolFormats } from '@nmtjs/protocol/server'
import { createServerHost } from '@nmtjs/server/node'
import { WsTransport } from '@nmtjs/ws-transport/node'

import { record } from '../../shared/support/_events.ts'

// resolved procedures carry an empty meta view: the HTTP transport reads the
// allowed-methods meta from it and falls back to its POST-only default
type ResolvedProcedure = GatewayResolvedProcedure & {
  meta: Map<unknown, unknown>
}

export default defineRuntimeWorker({
  definition: { fixture: 'shared-server' },
  createRuntime(ctx: NeemRuntimeWorkerContext) {
    let gateway: Gateway<ResolvedProcedure> | undefined

    return {
      async start(): Promise<NeemRuntimeUpstream[]> {
        const logger = createLogger(
          { pinoOptions: { enabled: false } },
          'shared-server',
        )
        const container = new Container({ logger })

        // both transports mount onto one socket: the gateway then reports
        // the same bound URL under both proxyable types
        const host = createServerHost({
          listen: { port: 0, hostname: '127.0.0.1' },
        })
        const http = await HttpTransport.factory({ server: host })
        const ws = await WsTransport.factory({ server: host })

        const api: GatewayApi<ResolvedProcedure> = {
          resolve: async ({ procedure }) => ({
            name: procedure,
            stream: false,
            meta: new Map(),
          }),
          call: async ({ procedure, payload }) => ({
            procedure,
            payload: payload ?? null,
            runtime: ctx.name,
          }),
        }

        gateway = new Gateway({
          logger,
          container,
          hooks: new Hooks(),
          formats: new ProtocolFormats([new JsonFormat()]),
          transports: {
            http: {
              // variance-only cast, same as the transports' own e2e suites:
              // this api's resolve() satisfies what each worker consumes
              transport: http as unknown as TransportWorker<
                ConnectionType,
                ResolvedProcedure
              >,
              proxyable: ProxyableTransportType.HTTP,
            },
            ws: {
              transport: ws as unknown as TransportWorker<
                ConnectionType,
                ResolvedProcedure
              >,
              proxyable: ProxyableTransportType.WS,
            },
          },
          api,
          heartbeat: false,
        })

        const hosts = await gateway.start()
        record({ event: 'shared-server-hosts', name: ctx.name, hosts })

        return hosts.map((entry) => ({
          type: entry.type as NeemRuntimeUpstream['type'],
          url: entry.url,
        }))
      },
      async stop() {
        const current = gateway
        gateway = undefined
        await current?.stop()
      },
    }
  },
})
