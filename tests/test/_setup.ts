import { EventEmitter } from 'node:events'

import type {
  ClientTransport,
  ClientTransportFactory,
  ClientTransportStartParams,
} from '@nmtjs/client'
import type { TAnyRouterContract } from '@nmtjs/contract'
import type {
  GatewayConnection,
  TransportWorker,
  TransportWorkerParams,
} from '@nmtjs/gateway'
import type { AnyProcedure, AnyRootRouter, AnyRouter } from 'nmtjs/runtime'
import {
  createTestClientFormat,
  createTestLogger,
  createTestServerFormat,
} from '@nmtjs/_tests'
import { StaticClient } from '@nmtjs/client/static'
import { Container, createLazyInjectable, Hooks } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'
import { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'
import { ProtocolFormats } from '@nmtjs/protocol/server'
import {
  ApplicationApi,
  isProcedure,
  isRouter,
  kDefaultProcedure,
  kRootRouter,
} from 'nmtjs/runtime'

const kUnknownProcedureForDefaultTest = '__tests__/unknown-procedure'

// =============================================================================
// EventEmitter Transport Channel
// =============================================================================

/**
 * A simple bidirectional channel using EventEmitters.
 * Creates a pair of connected endpoints for client-server communication.
 */
export class TransportChannel {
  readonly server = new EventEmitter()
  readonly client = new EventEmitter()

  constructor() {
    // Set high listener limit to avoid warnings during tests
    this.server.setMaxListeners(100)
    this.client.setMaxListeners(100)
  }

  // Server sends to client
  serverSend(event: string, data: unknown) {
    setTimeout(() => this.client.emit(event, data), 1)
  }

  // Client sends to server
  clientSend(event: string, data: unknown) {
    setTimeout(() => this.server.emit(event, data), 1)
  }
}

// =============================================================================
// EventEmitter Transport - Server Side
// =============================================================================

/**
 * Server-side transport using EventEmitter channel.
 */
export class EventEmitterServerTransport implements TransportWorker {
  private params: TransportWorkerParams | null = null
  private connections = new Map<string, GatewayConnection>()
  private channel: TransportChannel

  constructor(channel: TransportChannel) {
    this.channel = channel
  }

  async start(params: TransportWorkerParams): Promise<string> {
    this.params = params

    this.channel.server.on(
      'connect',
      async (message: {
        protocolVersion?: ProtocolVersion
        contentType?: string
      }) => {
        if (!this.params) return

        const connection = await this.params.onConnect({
          type: ConnectionType.Bidirectional,
          protocolVersion: message.protocolVersion ?? ProtocolVersion.v1,
          accept: message.contentType ?? 'application/json',
          contentType: message.contentType ?? 'application/json',
          data: {},
        })
        this.connections.set(connection.id, connection)
        // Send connection acknowledgment back to client
        this.channel.serverSend('connected', { connectionId: connection.id })
      },
    )

    this.channel.server.on(
      'disconnect',
      async (message: { connectionId: string }) => {
        if (!this.params) return
        await this.params.onDisconnect(message.connectionId)
        this.connections.delete(message.connectionId)
      },
    )

    this.channel.server.on(
      'message',
      async (message: { connectionId: string; data: Uint8Array }) => {
        if (!this.params) return
        // Create a proper ArrayBuffer from the Uint8Array
        const arrayBuffer = message.data.buffer.slice(
          message.data.byteOffset,
          message.data.byteOffset + message.data.byteLength,
        ) as ArrayBuffer
        await this.params.onMessage({
          connectionId: message.connectionId,
          data: arrayBuffer,
        })
      },
    )

    return 'event-emitter://localhost'
  }

  async stop(): Promise<void> {
    this.params = null
    this.connections.clear()
    this.channel.server.removeAllListeners()
  }

  send(connectionId: string, buffer: ArrayBufferView): boolean {
    const data = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    )
    this.channel.serverSend('message', { connectionId, data })
    return true
  }
}

// =============================================================================
// EventEmitter Transport - Client Side
// =============================================================================

/**
 * Client-side transport using EventEmitter channel.
 */
export class EventEmitterClientTransport
  implements ClientTransport<ConnectionType.Bidirectional>
{
  readonly type = ConnectionType.Bidirectional as const
  private channel: TransportChannel
  private params: ClientTransportStartParams | null = null
  private connectionId: string | null = null

  constructor(channel: TransportChannel) {
    this.channel = channel
  }

  async connect(params: ClientTransportStartParams): Promise<void> {
    this.params = params

    return new Promise<void>((resolve) => {
      this.channel.client.on(
        'connected',
        (message: { connectionId: string }) => {
          this.connectionId = message.connectionId
          this.params?.onConnect()
          resolve()
        },
      )

      this.channel.client.on(
        'message',
        (message: { connectionId: string; data: Uint8Array }) => {
          if (message.data) {
            this.params?.onMessage(message.data)
          }
        },
      )

      // Request connection
      this.channel.clientSend('connect', {
        protocolVersion: ProtocolVersion.v1,
        contentType: 'application/json',
      })
    })
  }

  async disconnect(): Promise<void> {
    if (this.connectionId) {
      this.channel.clientSend('disconnect', { connectionId: this.connectionId })
    }
    this.params?.onDisconnect('client')
    this.channel.client.removeAllListeners()
    this.connectionId = null
    this.params = null
  }

  async send(message: ArrayBufferView): Promise<void> {
    if (!this.connectionId) {
      throw new Error('Not connected')
    }
    const data = new Uint8Array(
      message.buffer,
      message.byteOffset,
      message.byteLength,
    )
    this.channel.clientSend('message', {
      connectionId: this.connectionId,
      data,
    })
  }
}

// =============================================================================
// Test Client
// =============================================================================

/**
 * Test client that extends StaticClient and exposes internal state for testing.
 * This allows tests to verify proper cleanup of internal maps without modifying
 * the production client code.
 */
export class TestClient<
  Transport extends ClientTransportFactory<any, any> = ClientTransportFactory<
    any,
    any
  >,
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
> extends StaticClient<Transport, RouterContract, SafeCall> {
  callUnknownProcedureForDefaultTest(payload?: unknown, options?: any) {
    return this._call(kUnknownProcedureForDefaultTest, payload, options)
  }

  /**
   * Get the number of pending calls in the internal calls map.
   * Should be 0 after all calls complete.
   */
  get pendingCallsCount() {
    return this.calls.size
  }

  /**
   * Get the number of active client streams (uploads in progress).
   * Should be 0 after all uploads complete.
   */
  get activeClientStreamsCount() {
    return this.clientStreams.size
  }

  /**
   * Get the number of active server streams (downloads in progress).
   * Should be 0 after all downloads complete.
   */
  get activeServerStreamsCount() {
    return this.serverStreams.size
  }

  /**
   * Get the number of active RPC streams.
   * Should be 0 after all streaming RPCs complete.
   */
  get activeRpcStreamsCount() {
    return this.rpcStreams.size
  }

  /**
   * Check if all client internal state is clean (no pending operations).
   */
  get isClean() {
    return (
      this.pendingCallsCount === 0 &&
      this.activeClientStreamsCount === 0 &&
      this.activeServerStreamsCount === 0 &&
      this.activeRpcStreamsCount === 0
    )
  }
}

// =============================================================================
// Test Setup
// =============================================================================

export interface TestSetup<TRouter extends AnyRootRouter> {
  gateway: Gateway
  client: TestClient<
    ClientTransportFactory<ConnectionType.Bidirectional, TransportChannel>,
    TRouter['contract'],
    false
  >
  channel: TransportChannel
  cleanup: () => Promise<void>
}

export interface TestSetupOptions<TRouter extends AnyRootRouter> {
  /** Custom router to use instead of the default rootRouter */
  router: TRouter
  /** Client timeout in ms (default: 5000) */
  timeout?: number
  /** Custom guards for ApplicationApi */
  guards?: []
  /** Custom middlewares for ApplicationApi */
  middlewares?: []
  /** Custom filters for ApplicationApi */
  filters?: []
}

// export function resetCounterValue() {
//   counterValue = 0
// }

function flattenRouter(router: AnyRootRouter) {
  const procedures = new Map<
    string | typeof kDefaultProcedure,
    { procedure: AnyProcedure; path: AnyRouter[] }
  >()
  const routers = new Map<string | kRootRouter, AnyRouter>()

  const registerRouter = (router: AnyRouter, path: AnyRouter[] = []) => {
    for (const route of Object.values(router.routes)) {
      if (isRouter(route)) {
        const name = path.length === 0 ? kRootRouter : route.contract.name
        if (!name) throw new Error('Nested routers must have a name')
        if (routers.has(name)) {
          throw new Error(`Router ${String(name)} already registered`)
        }
        routers.set(name, route)
        registerRouter(route, [...path, router])
      } else if (isProcedure(route)) {
        const name = route.contract.name
        if (!name) throw new Error('Procedures must have a name')
        if (procedures.has(name)) {
          throw new Error(`Procedure ${name} already registered`)
        }
        procedures.set(name, { procedure: route, path: [...path, router] })
      }
    }
  }

  routers.set(kRootRouter, router)
  registerRouter(router, [])

  if (router.default) {
    if (!isProcedure(router.default))
      throw new Error('Root router default must be a procedure')
    procedures.set(kDefaultProcedure, {
      procedure: router.default,
      path: [router],
    })
  }

  return procedures
}

/**
 * Creates a test setup with connected client and gateway.
 *
 * @example Default setup with built-in router
 * ```ts
 * const setup = await createTestSetup()
 * const result = await setup.client.call.echo({ message: 'hi' })
 * ```
 *
 * @example Custom router
 * ```ts
 * const myRouter = createRootRouter({ routers: [createRouter({
 *   routes: { myProc: createProcedure({ ... }) }
 * })] })
 * const setup = await createTestSetup({ router: myRouter })
 * const result = await setup.client.call.myProc({ ... })
 * ```
 */
export async function createTestSetup<TRouter extends AnyRootRouter>(
  options: TestSetupOptions<TRouter>,
): Promise<TestSetup<TRouter>> {
  const {
    router,
    timeout = 5000,
    guards = [],
    middlewares = [],
    filters = [],
  } = options

  const channel = new TransportChannel()

  // --- Server-side setup ---
  const logger = createTestLogger()
  const container = new Container({ logger })
  const hooks = new Hooks()
  const serverFormat = createTestServerFormat()
  const serverTransport = new EventEmitterServerTransport(channel)

  // Simple identity resolver
  const identityResolver = createLazyInjectable<string>()
  container.provide(identityResolver, 'test-identity')

  // Create ApplicationApi with real procedures
  const api = new ApplicationApi({
    logger,
    container,
    procedures: flattenRouter(router),
    guards: new Set(guards),
    middlewares: new Set(middlewares),
    filters: new Set(filters),
  })

  const gateway = new Gateway({
    logger,
    container,
    hooks,
    formats: new ProtocolFormats([serverFormat]),
    api,
    identity: identityResolver,
    transports: { 'event-emitter': { transport: serverTransport } },
  })

  await gateway.start()

  // --- Client-side setup ---
  const clientFormat = createTestClientFormat()

  const transportFactory: ClientTransportFactory<
    ConnectionType.Bidirectional,
    TransportChannel
  > = (_params, ch) => new EventEmitterClientTransport(ch)

  const client = new TestClient(
    {
      contract: router.contract,
      protocol: ProtocolVersion.v1,
      format: clientFormat,
      timeout,
    },
    transportFactory,
    channel,
  )

  await client.connect()

  return {
    gateway,
    client,
    channel,
    cleanup: async () => {
      await client.disconnect()
      await gateway.stop()
    },
  }
}

export type { ClientTransportFactory } from '@nmtjs/client'
// Re-export useful types and utilities for tests
export {
  createTestClientFormat,
  createTestLogger,
  createTestServerFormat,
} from '@nmtjs/_tests'
export { StaticClient } from '@nmtjs/client/static'
export { c } from '@nmtjs/contract'
export { Container, createLazyInjectable, Hooks } from '@nmtjs/core'
export {
  createBlob,
  Gateway,
  rpcAbortSignal,
  rpcStreamAbortSignal,
} from '@nmtjs/gateway'
export {
  ConnectionType,
  ErrorCode,
  ProtocolBlob,
  ProtocolVersion,
} from '@nmtjs/protocol'
export { ProtocolError, ProtocolFormats } from '@nmtjs/protocol/server'
export { t } from '@nmtjs/type'
export {
  ApiError,
  ApplicationApi,
  createProcedure,
  createRootRouter,
  createRouter,
} from 'nmtjs/runtime'
