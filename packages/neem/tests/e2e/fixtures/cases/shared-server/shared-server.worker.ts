import type {
  GatewayApi,
  GatewayResolvedProcedure,
  GatewayStaticMetaView,
} from '@nmtjs/gateway'
import type { NeemRuntimeUpstream, NeemRuntimeWorkerContext } from '@nmtjs/neem'
import { Container, createLogger, Hooks } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'
import { JsonFormat } from '@nmtjs/json-format/server'
import { defineRuntimeWorker } from '@nmtjs/neem'
import { ProtocolFormats } from '@nmtjs/protocol/server'
import { createServerTransport } from '@nmtjs/transports'
import { createServerHost } from '@nmtjs/transports/host/node'
import { neemataHttp } from '@nmtjs/transports/http'
import { neemataWebSocket } from '@nmtjs/transports/ws'

import { record } from '../../shared/support/_events.ts'

// resolved procedures carry an empty meta view: the HTTP transport reads the
// allowed-methods meta from it and falls back to its POST-only default
type ResolvedProcedure = GatewayResolvedProcedure & {
  meta: Pick<GatewayStaticMetaView, 'get'>
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

        // both handlers mount onto one socket: the gateway then reports
        // the same bound URL under both proxyable types
        const ServerTransport = createServerTransport({
          host: createServerHost,
          handlers: {
            http: neemataHttp(),
            ws: neemataWebSocket(),
          },
        })
        const server = await ServerTransport.factory({
          listen: { port: 0, hostname: '127.0.0.1' },
          handlers: { http: { path: '/' }, ws: { path: '/' } },
        })

        const api: GatewayApi<ResolvedProcedure> = {
          resolve: async ({ procedure }) => ({
            name: procedure,
            stream: false,
            meta: { get: () => undefined },
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
            server: {
              transport: server,
              proxyable: ServerTransport.proxyable,
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
