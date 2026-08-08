import type { MaybePromise } from '@nmtjs/common'
import type { LazyInjectable, Scope } from '@nmtjs/core'
import type {
  GatewayResolvedProcedure,
  ProxyableTransportType,
  SendResult,
  Transport,
  TransportWorkerParams,
} from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import { Lifecycle } from '@nmtjs/common'
import { ConnectionType as ConnectionTypeValue } from '@nmtjs/protocol'

import type {
  ServerHost,
  ServerHostOptions,
  ServerRuntimeName,
} from './types.ts'

type AnyInjections = Record<
  string,
  LazyInjectable<any, Scope.Connection | Scope.Call>
>

export interface ServerHandlerContext<
  R extends ServerRuntimeName = ServerRuntimeName,
  Type extends ConnectionType = ConnectionType,
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  host: ServerHost<R>
  gateway: TransportWorkerParams<Type, ResolvedProcedure>
}

export interface MountedServerHandler {
  dispose(): MaybePromise<void>
  send?(connectionId: string, buffer: ArrayBufferView): SendResult
  close?(
    connectionId: string,
    options?: { code?: number; reason?: string },
  ): MaybePromise<void>
}

export interface ServerHandler<
  Type extends ConnectionType = ConnectionType,
  Options = unknown,
  Injections extends AnyInjections = AnyInjections,
  Proxyable extends readonly ProxyableTransportType[] =
    readonly ProxyableTransportType[],
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  readonly proxyable: Proxyable
  readonly injectables?: Injections
  mount<R extends ServerRuntimeName>(
    context: ServerHandlerContext<R, Type, ResolvedProcedure>,
    options: Options,
  ): MaybePromise<MountedServerHandler>
}

type AnyServerHandler = ServerHandler<any, any, any, any, any>

type HandlerOptionsOf<T> =
  T extends ServerHandler<any, infer Options, any, any, any> ? Options : never

type HandlerInjectionsOf<T> =
  T extends ServerHandler<any, any, infer Injections, any, any>
    ? Injections
    : never

type HandlerProxyableOf<T> =
  T extends ServerHandler<any, any, any, infer Proxyable, any>
    ? Proxyable[number]
    : never

type HandlerResolvedProcedureOf<T> =
  T extends ServerHandler<any, any, any, any, infer ResolvedProcedure>
    ? ResolvedProcedure
    : never

type UnionToIntersection<T> = (
  T extends unknown ? (value: T) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never

type CombinedResolvedProcedure<
  Handlers extends Record<string, AnyServerHandler>,
> = UnionToIntersection<HandlerResolvedProcedureOf<Handlers[keyof Handlers]>> &
  GatewayResolvedProcedure

type KeysOfUnion<T> = T extends T ? keyof T : never
type ValueOfUnion<T, K extends PropertyKey> =
  T extends Record<K, infer Value> ? Value : never

type CombinedHandlerInjections<
  Handlers extends Record<string, AnyServerHandler>,
> = {
  [K in KeysOfUnion<
    HandlerInjectionsOf<Handlers[keyof Handlers]>
  >]: ValueOfUnion<HandlerInjectionsOf<Handlers[keyof Handlers]>, K>
} & AnyInjections

export type ServerTransportOptions<
  R extends ServerRuntimeName,
  Handlers extends Record<string, AnyServerHandler>,
> = ServerHostOptions<R> & {
  handlers: {
    [K in keyof Handlers]: HandlerOptionsOf<Handlers[K]>
  }
}

export type ServerTransport<
  R extends ServerRuntimeName,
  Handlers extends Record<string, AnyServerHandler>,
> = Transport<
  ConnectionType,
  ServerTransportOptions<R, Handlers>,
  CombinedHandlerInjections<Handlers>,
  readonly HandlerProxyableOf<Handlers[keyof Handlers]>[],
  CombinedResolvedProcedure<Handlers>
>

export function createServerTransport<
  R extends ServerRuntimeName,
  const Handlers extends Record<string, AnyServerHandler>,
>(config: {
  host: (options: ServerHostOptions<R>) => ServerHost<R>
  handlers: Handlers
}): ServerTransport<R, Handlers> {
  if (Object.keys(config.handlers).length === 0) {
    throw new Error('A server transport requires at least one handler')
  }

  return {
    proxyable: collectProxyableTypes(
      config.handlers,
    ) as readonly HandlerProxyableOf<Handlers[keyof Handlers]>[],
    injectables: collectInjectables(
      config.handlers,
    ) as CombinedHandlerInjections<Handlers>,
    factory(options) {
      const { handlers: handlerOptions, ...hostOptions } = options
      const host = config.host(hostOptions)
      const lifecycle = new Lifecycle<string>('server transport')
      const mounted: Record<string, MountedServerHandler> = {}
      const owners = new Map<string, string>()

      return {
        start(params) {
          return lifecycle.start(async (defer) => {
            // deferred before any mount so it unwinds last: the socket must
            // close only after every handler has disposed (a live WS peer
            // would otherwise make a graceful runtime stop wait forever);
            // stop() on a never-started host is a no-op
            defer(async () => {
              owners.clear()
              await host.stop()
            })
            for (const key in config.handlers) {
              const handler = await config.handlers[key].mount(
                {
                  host,
                  gateway: createHandlerParams(key, params, owners),
                },
                handlerOptions[key],
              )
              mounted[key] = handler
              defer(async () => {
                delete mounted[key]
                await handler.dispose()
              })
            }
            return await host.start()
          })
        },
        stop() {
          return lifecycle.stop()
        },
        send(connectionId, buffer): SendResult {
          const owner = owners.get(connectionId)
          if (!owner) return 'dropped'
          const handler = mounted[owner]
          return handler?.send ? handler.send(connectionId, buffer) : 'dropped'
        },
        close(connectionId, options) {
          const owner = owners.get(connectionId)
          owners.delete(connectionId)
          if (owner) return mounted[owner]?.close?.(connectionId, options)
        },
      }
    },
  }
}

function createHandlerParams(
  key: string,
  params: TransportWorkerParams<any, any>,
  owners: Map<string, string>,
): TransportWorkerParams<any, any> {
  return {
    ...params,
    async onConnect(options, ...injections) {
      const connection = await params.onConnect(options, ...injections)
      if (options.type === ConnectionTypeValue.Bidirectional) {
        owners.set(connection.id, key)
      }
      return connection
    },
    async onDisconnect(connectionId) {
      owners.delete(connectionId)
      await params.onDisconnect(connectionId)
    },
  }
}

function collectProxyableTypes(
  handlers: Record<string, AnyServerHandler>,
): readonly ProxyableTransportType[] {
  return [
    ...new Set(Object.values(handlers).flatMap(({ proxyable }) => proxyable)),
  ]
}

/**
 * Handlers publish injectables under a flat namespace; two handlers may
 * share a key only when it is literally the same injectable (e.g. the
 * gateway connection-data token re-exported by both http and ws). A distinct
 * instance under a colliding key would silently lose to last-wins at
 * request-provision time, so it throws here — at transport creation, the
 * earliest possible moment.
 */
function collectInjectables(
  handlers: Record<string, AnyServerHandler>,
): AnyInjections {
  const combined = Object.create(null) as AnyInjections
  for (const [handlerKey, { injectables }] of Object.entries(handlers)) {
    for (const key in injectables) {
      const injectable = injectables[key]
      if (Object.hasOwn(combined, key) && combined[key] !== injectable) {
        throw new Error(
          `Server handler [${handlerKey}] conflicts on injectable [${key}]`,
        )
      }
      combined[key] = injectable
    }
  }
  return combined
}
