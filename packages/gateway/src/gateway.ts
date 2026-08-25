import { randomUUID } from 'node:crypto'
import { isTypedArray } from 'node:util/types'

import type {
  ChildLoggerOptions,
  Container,
  Hooks,
  Logger,
  Provision,
} from '@nmtjs/core'
import {
  anyAbortSignal,
  createFuture,
  TeardownStack,
  withTimeout,
} from '@nmtjs/common'
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

type ConnectionInput = {
  data: unknown
  injections: readonly Provision[]
}

type ConnectionCall = {
  controller: AbortController
  finished: Promise<void>
}

export interface GatewayOptions<
  ResolvedProcedure extends GatewayResolvedProcedure = GatewayResolvedProcedure,
> {
  logger: Logger
  container: Container
  hooks: Hooks
  api: GatewayApi<ResolvedProcedure>
  transports: {
    [key: string]: {
      transport: TransportWorker<ResolvedProcedure>
      proxyable?: readonly ProxyableTransportType[]
    }
  }
  identity?: ConnectionIdentity
}

/**
 * Upper bound per connection teardown step so a never-settling container
 * disposal can't hang closeConnection() and stop().
 */
export const GATEWAY_TEARDOWN_STEP_TIMEOUT = 10_000

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
  private readonly connectionCalls = new Map<string, Set<ConnectionCall>>()
  private readonly connectionInputs = new Map<string, ConnectionInput>()
  readonly #startedTransports = new TeardownStack()
  private reloadBarrier: Promise<void> = Promise.resolve()
  private pendingReloads = 0
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
    const hosts: { url: string; type: ProxyableTransportType }[] = []
    try {
      for (const transportKey in this.options.transports) {
        const { transport, proxyable } = this.options.transports[transportKey]
        const url = await transport.start({
          onConnect: this.onConnect(transportKey),
          onDisconnect: this.onDisconnect(transportKey),
          resolve: this.resolve(transportKey),
          onRpc: this.onRpc(transportKey),
        })
        this.#startedTransports.defer(async () => {
          await transport.stop()
          this.logger.debug(`Transport [${transportKey}] stopped`)
        })
        this.logger.info(`Transport [${transportKey}] started on [${url}]`)

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
    if (this.pendingReloads > 0) await this.reloadBarrier
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

  reload(
    options?: Pick<
      GatewayOptions<ResolvedProcedure>,
      'api' | 'container' | 'hooks' | 'identity'
    >,
  ): Promise<void> {
    this.pendingReloads++
    const reload = this.reloadBarrier.then(() => this.performReload(options))
    // Connection callbacks wait on a non-rejecting copy so one failed reload
    // does not poison future traffic or a later recovery reload.
    this.reloadBarrier = reload.then(
      () => undefined,
      () => undefined,
    )
    void reload.then(
      () => this.pendingReloads--,
      () => this.pendingReloads--,
    )
    return reload
  }

  protected onConnect(transport: string): TransportWorkerParams['onConnect'] {
    const logger = forkLogger(this.logger, undefined, undefined, { transport })
    return async (options, ...injections) => {
      logger.trace('Initiating new connection')

      const id = randomUUID()
      while (true) {
        const barrier = this.reloadBarrier
        if (this.pendingReloads > 0) await barrier
        const container = this.options.container.fork(Scope.Connection)

        try {
          container.provide([
            provision(injectables.connectionData, options.data),
            provision(injectables.connectionId, id),
          ])
          container.provide(injections)

          const identity = await container.resolve(this.options.identity)

          // Identity resolution can yield while a reload starts. Retry under
          // the replacement root so no new connection retains the old scope.
          if (barrier !== this.reloadBarrier) {
            await container.dispose()
            continue
          }

          const abortController = new AbortController()
          const connection: GatewayConnection = {
            id,
            identity,
            container,
            abortController,
          }

          container.provide([
            provision(injectables.connection, connection),
            provision(
              injectables.connectionAbortSignal,
              abortController.signal,
            ),
          ])
          this.connections.add(connection)
          this.connectionInputs.set(id, {
            data: options.data,
            injections: [...injections],
          })

          logger.debug(
            { id, identity, transportData: options.data },
            'Connection established',
          )

          return Object.assign(connection, {
            [Symbol.asyncDispose]: async () => {
              await this.onDisconnect(transport)(connection.id)
            },
          })
        } catch (error) {
          logger.error({ error }, 'Error establishing connection')
          await container.dispose()
          throw error
        }
      }
    }
  }

  protected onDisconnect(
    transport: string,
  ): TransportWorkerParams['onDisconnect'] {
    const logger = forkLogger(this.logger, undefined, undefined, { transport })
    return async (connectionId) => {
      if (this.pendingReloads > 0) await this.reloadBarrier
      logger.debug({ connectionId }, 'Disconnecting connection')
      await this.closeConnection(connectionId)
    }
  }

  protected resolve(
    transport: string,
  ): TransportWorkerParams<ResolvedProcedure>['resolve'] {
    const _logger = forkLogger(this.logger, undefined, undefined, { transport })

    return async (connection, procedure) => {
      if (this.pendingReloads > 0) await this.reloadBarrier
      _logger.trace({ connectionId: connection.id, procedure }, 'Resolving RPC')

      return this.options.api.resolve({ connection, procedure })
    }
  }

  protected onRpc(transport: string): TransportWorkerParams['onRpc'] {
    const _logger = forkLogger(this.logger, undefined, undefined, { transport })

    return async (connection, rpc, signal, ...injections) => {
      if (this.pendingReloads > 0) await this.reloadBarrier
      const controller = new AbortController()
      const finished = createFuture<void>()
      const call = { controller, finished: finished.promise }
      this.trackCall(connection.id, call)
      const callSignal = anyAbortSignal(signal, controller.signal)

      const container = connection.container.fork(Scope.Call)
      let disposal: Promise<void> | undefined
      const dispose = () => {
        disposal ??= container.dispose().finally(() => {
          this.untrackCall(connection.id, call)
          finished.resolve()
        })
        return disposal
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
    this.connectionInputs.delete(connectionId)

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
    await guard(() => {
      this.abortCalls(connectionId)
      this.connectionCalls.delete(connectionId)
    })
    await guard(() => connection.container.dispose())
  }

  private async performReload(
    options?: Pick<
      GatewayOptions<ResolvedProcedure>,
      'api' | 'container' | 'hooks' | 'identity'
    >,
  ): Promise<void> {
    const next = {
      api: options?.api ?? this.options.api,
      container: options?.container ?? this.options.container,
      hooks: options?.hooks ?? this.options.hooks,
      identity: options?.identity ?? this.options.identity,
    }
    const replacements: Array<{
      connection: GatewayConnection
      container: Container
      identity: string
    }> = []

    try {
      for (const connection of this.connections.getAll()) {
        const input = this.connectionInputs.get(connection.id)
        if (!input) {
          throw new Error(
            `Cannot reload gateway connection [${connection.id}] without its connection inputs`,
          )
        }

        const container = next.container.fork(Scope.Connection)
        try {
          container.provide([
            provision(injectables.connectionData, input.data),
            provision(injectables.connectionId, connection.id),
            ...input.injections,
          ])
          const identity = await container.resolve(next.identity)
          container.provide([
            provision(injectables.connection, connection),
            provision(
              injectables.connectionAbortSignal,
              connection.abortController.signal,
            ),
          ])
          replacements.push({ connection, container, identity })
        } catch (error) {
          await container.dispose()
          throw error
        }
      }

      for (const { connection } of replacements) {
        this.abortCalls(connection.id)
      }
      await Promise.all(
        replacements.map(({ connection }) =>
          this.waitForCallsToDrain(connection.id),
        ),
      )
    } catch (error) {
      await Promise.allSettled(
        replacements.map(({ container }) => container.dispose()),
      )
      throw error
    }

    this.options.api = next.api
    this.options.container = next.container
    this.options.hooks = next.hooks
    this.options.identity = next.identity

    await Promise.all(
      replacements.map(async ({ connection, container, identity }) => {
        const previous = connection.container
        connection.container = container
        connection.identity = identity
        await previous.dispose()
      }),
    )
  }

  private trackCall(connectionId: string, call: ConnectionCall) {
    let calls = this.connectionCalls.get(connectionId)
    if (!calls) {
      calls = new Set()
      this.connectionCalls.set(connectionId, calls)
    }
    calls.add(call)
  }

  private untrackCall(connectionId: string, call: ConnectionCall) {
    const calls = this.connectionCalls.get(connectionId)
    if (calls) {
      calls.delete(call)
      if (calls.size === 0) this.connectionCalls.delete(connectionId)
    }
  }

  private abortCalls(connectionId: string) {
    const calls = this.connectionCalls.get(connectionId)
    if (calls) {
      for (const call of calls) call.controller.abort()
    }
  }

  private async waitForCallsToDrain(connectionId: string): Promise<void> {
    const calls = this.connectionCalls.get(connectionId)
    if (!calls?.size) return

    await withTimeout(
      Promise.allSettled([...calls].map((call) => call.finished)),
      GATEWAY_TEARDOWN_STEP_TIMEOUT,
      new Error(
        `Connection [${connectionId}] calls did not drain before gateway reload`,
      ),
    )
  }
}

export const gatewayLoggerOptions: ChildLoggerOptions = {
  serializers: {
    chunk: (chunk) =>
      isTypedArray(chunk) ? `<Buffer length=${chunk.byteLength}>` : chunk,
    payload: (payload) => {
      function traverseObject(obj: any): any {
        if (Array.isArray(obj)) {
          return obj.map(traverseObject)
        } else if (isTypedArray(obj)) {
          return `<${obj.constructor.name} length=${obj.byteLength}>`
        } else if (isBlobInterface(obj)) {
          // must run before the generic object branch, blobs are objects too
          return `<ClientBlobStream metadata=${JSON.stringify(obj.metadata)}>`
        } else if (typeof obj === 'object' && obj !== null) {
          const result: Record<string, any> = {}
          for (const [key, value] of Object.entries(obj)) {
            result[key] = traverseObject(value)
          }
          return result
        }
        return obj
      }
      return traverseObject(payload)
    },
    headers: (value) => {
      if (value instanceof Headers) {
        const obj: Record<string, any> = {}
        value.forEach((v, k) => {
          obj[k] = v
        })
        return obj
      }
      return value
    },
  },
}
