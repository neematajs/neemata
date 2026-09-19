import { randomUUID } from 'node:crypto'
import { isTypedArray } from 'node:util/types'

import type { ChildLoggerOptions, Container, Hooks, Logger } from '@nmtjs/core'
import { anyAbortSignal, TeardownStack, withTimeout } from '@nmtjs/common'
import {
  createFactoryInjectable,
  forkLogger,
  provision,
  Scope,
} from '@nmtjs/core'
import { isBlobInterface } from '@nmtjs/protocol'

import type { GatewayApi, GatewayResolvedProcedure } from './api.ts'
import type { GatewayConnection } from './connections.ts'
import type { ProxyableTransportType } from './enums.ts'
import type { TransportWorker, TransportWorkerParams } from './transport.ts'
import type { ConnectionIdentity } from './types.ts'
import { ConnectionManager } from './connections.ts'
import * as injectables from './injectables.ts'

export type GatewayHost = { url: string; type: ProxyableTransportType }

export type GatewayTransports<
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> = {
  [key: string]: {
    transport: TransportWorker<ResolvedProcedure>
    proxyable?: readonly ProxyableTransportType[]
  }
}

export interface GatewayOptions<
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  logger: Logger
  container: Container
  hooks: Hooks
  api: GatewayApi<ResolvedProcedure>
  transports: GatewayTransports<ResolvedProcedure>
  identity?: ConnectionIdentity
}

/**
 * Upper bound per connection teardown step so a never-settling container
 * disposal can't hang closeConnection() and stop().
 */
export const GATEWAY_TEARDOWN_STEP_TIMEOUT = 10_000

function serializePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serializePayload)
  if (isTypedArray(value)) {
    return `<${value.constructor.name} length=${value.byteLength}>`
  }
  if (isBlobInterface(value)) {
    // must run before the generic object branch, blobs are objects too
    return `<ClientBlobStream metadata=${JSON.stringify(value.metadata)}>`
  }
  if (typeof value !== 'object' || value === null) return value

  const fields: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    fields[key] = serializePayload(field)
  }
  return fields
}

export const gatewayLoggerOptions: ChildLoggerOptions = {
  serializers: {
    chunk: (chunk) =>
      isTypedArray(chunk) ? `<Buffer length=${chunk.byteLength}>` : chunk,
    payload: serializePayload,
    headers: (value) =>
      value instanceof Headers ? Object.fromEntries(value) : value,
  },
}

/**
 * Application-session kernel. Owns connection scopes, identity, procedure
 * resolution, invocation, cancellation composition, and disposal — and
 * nothing wire-level. Transport handlers own the physical connections and
 * everything bytes-shaped (codecs, frames, credits, heartbeats); they talk
 * to the gateway exclusively through the TransportWorkerParams surface,
 * exchanging runtime values.
 */
export class Gateway<
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  readonly logger: Logger
  readonly connections: ConnectionManager
  // In-flight teardowns keyed by connection id, see closeConnection
  private readonly closingConnections = new Map<string, Promise<void>>()
  /**
   * Outstanding application calls per connection: disconnect must abort
   * every in-flight call even when the transport's own per-call signal
   * never fires (e.g. an abort-ignoring peer).
   */
  private readonly connectionCalls = new Map<string, Set<AbortController>>()
  readonly #startedTransports = new TeardownStack()
  public options: Required<GatewayOptions<ResolvedProcedure>>

  constructor(options: GatewayOptions<ResolvedProcedure>) {
    this.options = {
      ...options,
      identity:
        options.identity ??
        createFactoryInjectable({
          dependencies: { connectionId: injectables.connectionId },
          create: ({ connectionId }) => connectionId,
        }),
    }
    this.logger = forkLogger(options.logger, undefined, gatewayLoggerOptions)
    this.connections = new ConnectionManager()
  }

  async start() {
    const hosts: GatewayHost[] = []
    try {
      for (const [key, { transport, proxyable }] of Object.entries(
        this.options.transports,
      )) {
        const url = await transport.start(this.createTransportParams(key))
        this.#startedTransports.defer(async () => {
          await transport.stop()
          this.logger.debug(`Transport [${key}] stopped`)
        })
        this.logger.info(`Transport [${key}] started on [${url}]`)

        for (const type of new Set(proxyable ?? [])) hosts.push({ url, type })
      }
    } catch (error) {
      const rollbackErrors = await this.#startedTransports.unwind()
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Failed to start gateway and roll back transports',
        )
      }
      throw error
    }
    return hosts
  }

  async stop() {
    // Transports stop first: handlers close their physical sessions, which
    // delivers a disconnect per connection through the normal path
    const errors = await this.#startedTransports.unwind()

    // Sweep application scopes whose transport never reported a disconnect
    for (const connection of this.connections.getAll()) {
      await this.closeConnection(connection.id)
    }

    // Also wait for teardowns already claimed by concurrent callers —
    // they are no longer in the map
    await Promise.all(this.closingConnections.values())

    if (errors.length) {
      throw new AggregateError(errors, 'Failed to stop gateway transports')
    }
  }

  async reload(
    options?: Pick<
      GatewayOptions<ResolvedProcedure>,
      'api' | 'container' | 'hooks' | 'identity'
    >,
  ) {
    // Own the hot-swap of these options internally so callers don't reach into
    // `this.options` directly; identity falls back to the current one.
    if (options) {
      this.options.api = options.api
      this.options.container = options.container
      this.options.hooks = options.hooks
      this.options.identity = options.identity ?? this.options.identity
    }

    for (const connection of this.connections.getAll()) {
      await connection.container.dispose()
    }
  }

  protected createTransportParams(
    transport: string,
  ): TransportWorkerParams<ResolvedProcedure> {
    const logger = forkLogger(this.logger, undefined, undefined, { transport })
    const onDisconnect = this.createDisconnectHandler(logger)

    return {
      onConnect: this.createConnectHandler(logger, onDisconnect),
      onDisconnect,
      resolve: this.createResolveHandler(logger),
      onRpc: this.createRpcHandler(),
    }
  }

  protected createConnectHandler(
    logger: Logger,
    onDisconnect: TransportWorkerParams['onDisconnect'],
  ): TransportWorkerParams['onConnect'] {
    return async (options, ...injections) => {
      logger.trace('Initiating new connection')

      const id = randomUUID()
      const container = this.options.container.fork(Scope.Connection)

      try {
        container.provide([
          provision(injectables.connectionData, options.data),
          provision(injectables.connectionId, id),
        ])
        container.provide(injections)

        const identity = await container.resolve(this.options.identity)

        const abortController = new AbortController()

        const connection: GatewayConnection = {
          id,
          identity,
          container,
          abortController,
        }

        this.connections.add(connection)

        container.provide([
          provision(injectables.connection, connection),
          provision(injectables.connectionAbortSignal, abortController.signal),
        ])

        logger.debug(
          { id, identity, transportData: options.data },
          'Connection established',
        )

        return Object.assign(connection, {
          [Symbol.asyncDispose]: async () => {
            await onDisconnect(connection.id)
          },
        })
      } catch (error) {
        logger.error({ error }, 'Error establishing connection')
        await container.dispose()
        throw error
      }
    }
  }

  protected createDisconnectHandler(
    logger: Logger,
  ): TransportWorkerParams['onDisconnect'] {
    return async (connectionId) => {
      logger.debug({ connectionId }, 'Disconnecting connection')
      await this.closeConnection(connectionId)
    }
  }

  protected createResolveHandler(
    logger: Logger,
  ): TransportWorkerParams<ResolvedProcedure>['resolve'] {
    return async (connection, procedure) => {
      logger.trace({ connectionId: connection.id, procedure }, 'Resolving RPC')

      return this.options.api.resolve({ connection, procedure })
    }
  }

  protected createRpcHandler(): TransportWorkerParams['onRpc'] {
    return async (connection, rpc, signal, ...injections) => {
      const controller = new AbortController()
      this.trackCall(connection.id, controller)
      const callSignal = anyAbortSignal(signal, controller.signal)

      const container = connection.container.fork(Scope.Call)

      const dispose = async () => {
        this.untrackCall(connection.id, controller)
        await container.dispose()
      }

      try {
        container.provide([
          ...injections,
          provision(injectables.rpcClientAbortSignal, callSignal),
        ])

        const result = await this.options.api.call({
          connection,
          container,
          payload: rpc.payload,
          procedure: rpc.procedure,
          signal: callSignal,
        })

        // Streaming results come back as a thunk taking an on-done callback:
        // the call scope must stay alive until the returned iterable
        // completes, fails, or is cancelled — the transport pumps it
        if (typeof result === 'function') {
          return result(dispose)
        }
        await dispose()
        return result
      } catch (error) {
        await dispose()
        throw error
      }
    }
  }

  protected closeConnection(connectionId: string): Promise<void> {
    // Single-flight: the first caller claims the connection by removing it
    // from the map before any await; concurrent callers await the same
    // in-flight teardown instead of tearing down twice.
    const inFlight = this.closingConnections.get(connectionId)
    if (inFlight) return inFlight
    if (!this.connections.has(connectionId)) return Promise.resolve()

    const connection = this.connections.get(connectionId)
    this.connections.remove(connectionId)

    const teardown = this.teardownConnection(connection).finally(() => {
      this.closingConnections.delete(connectionId)
    })
    this.closingConnections.set(connectionId, teardown)
    return teardown
  }

  private async teardownConnection(connection: GatewayConnection) {
    const connectionId = connection.id

    // Guard and time-bound each teardown step so one failure or a
    // never-settling promise can't skip or hang the rest.
    const guard = async (step: () => unknown) => {
      try {
        await withTimeout(
          Promise.resolve(step()),
          GATEWAY_TEARDOWN_STEP_TIMEOUT,
          new Error('Connection teardown step timed out'),
        )
      } catch (error) {
        this.logger.error(
          { error, connectionId },
          'Error during connection teardown',
        )
      }
    }

    await guard(() => connection.abortController.abort())
    await guard(() => this.abortCalls(connectionId))
    await guard(() => connection.container.dispose())
  }

  private trackCall(connectionId: string, controller: AbortController) {
    let calls = this.connectionCalls.get(connectionId)
    if (!calls) {
      calls = new Set()
      this.connectionCalls.set(connectionId, calls)
    }
    calls.add(controller)
  }

  private untrackCall(connectionId: string, controller: AbortController) {
    const calls = this.connectionCalls.get(connectionId)
    if (calls) {
      calls.delete(controller)
      if (calls.size === 0) this.connectionCalls.delete(connectionId)
    }
  }

  private abortCalls(connectionId: string) {
    const calls = this.connectionCalls.get(connectionId)
    if (calls) {
      this.connectionCalls.delete(connectionId)
      for (const controller of calls) controller.abort()
    }
  }
}
