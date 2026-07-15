import type { ApplicationResolvedProcedure } from '@nmtjs/application'
import type { TransportWorker, TransportWorkerParams } from '@nmtjs/gateway'
import type { Hooks, Peer } from 'crossws'
import { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'
import { defineHooks } from 'crossws'

import type {
  WsAdapterParams,
  WsAdapterServer,
  WsAdapterServerFactory,
  WsTransportOptions,
  WsTransportServerRequest,
} from './types.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
} from './utils.ts'

/**
 * How long an upgraded connection may stay without its `open` hook firing
 * before it is reaped. Sockets that die between upgrade and open never get a
 * `close` hook, which would leak the gateway connection and its container.
 */
export const WS_PENDING_OPEN_TTL = 10_000

export function createWSTransportWorker(
  adapterFactory: WsAdapterServerFactory<any>,
  options: WsTransportOptions,
): TransportWorker<ConnectionType.Bidirectional, ApplicationResolvedProcedure> {
  return new WsTransportServer(adapterFactory, options)
}

export class WsTransportServer implements TransportWorker<
  ConnectionType.Bidirectional,
  ApplicationResolvedProcedure
> {
  #server: WsAdapterServer
  params!: TransportWorkerParams<
    ConnectionType.Bidirectional,
    ApplicationResolvedProcedure
  >
  clients = new Map<string, Peer>()
  // Reap timers for upgraded-but-not-opened connections, see WS_PENDING_OPEN_TTL
  pendingOpen = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    protected readonly adapterFactory: WsAdapterServerFactory<any>,
    protected readonly options: WsTransportOptions,
  ) {
    this.#server = this.createServer()
  }

  async start(
    hooks: TransportWorkerParams<
      ConnectionType.Bidirectional,
      ApplicationResolvedProcedure
    >,
  ): Promise<string> {
    this.params = hooks
    return await this.#server.start()
  }

  async stop(): Promise<void> {
    for (const timer of this.pendingOpen.values()) clearTimeout(timer)
    this.pendingOpen.clear()
    for (const peer of this.clients.values()) {
      try {
        peer.close(1001, 'Transport stopped')
      } catch (error) {
        console.error(
          `Failed to close WebSocket connection ${peer.context.connectionId}`,
          error,
        )
      }
    }
    this.clients.clear()
    await this.#server.stop()
  }

  send(connectionId: string, buffer: ArrayBufferView) {
    const peer = this.clients.get(connectionId)
    if (!peer) return false

    try {
      const result = peer.send(buffer)
      if (typeof result === 'boolean') return result
      if (typeof result === 'number') return result > 0
      return true
    } catch (error) {
      console.error(
        `Failed to send data over WebSocket connection ${connectionId}`,
        error,
      )
      this.clients.delete(connectionId)
      return false
    }
  }

  close(
    connectionId: string,
    options: { code?: number; reason?: string } = {},
  ) {
    // A gateway-initiated close may land before `open` (e.g. heartbeat
    // timeout); claim the reap timer so it can't fire a redundant disconnect
    this.clearPendingOpenReap(connectionId)
    const peer = this.clients.get(connectionId)
    if (!peer) return
    this.clients.delete(connectionId)
    try {
      peer.close(options.code ?? 1001, options.reason ?? 'Closed')
    } catch (error) {
      console.error(
        `Failed to close WebSocket connection ${connectionId}`,
        error,
      )
    }
  }

  private createWsHooks(): Hooks {
    return defineHooks({
      upgrade: async (req) => {
        const url = new URL(req.url)

        if (url.pathname !== '/') {
          return NotFoundHttpResponse()
        }

        const request: WsTransportServerRequest = {
          url,
          headers: req.headers,
          method: req.method,
        }

        const accept =
          url.searchParams.get('accept') ?? req.headers.get('accept')
        const contentType =
          url.searchParams.get('content-type') ??
          req.headers.get('content-type')

        try {
          const connection = await this.params.onConnect({
            type: ConnectionType.Bidirectional,
            protocolVersion: ProtocolVersion.v1,
            accept,
            contentType,
            data: request,
          })

          this.schedulePendingOpenReap(connection.id)

          return { context: { connectionId: connection.id } }
        } catch (error) {
          console.error('Failed to upgrade WebSocket connection', error)
          return InternalServerErrorHttpResponse()
        }
      },
      open: (peer) => {
        const { connectionId } = peer.context
        // If the reap already claimed this connection, the gateway side is
        // gone — close the late peer instead of registering a zombie
        if (!this.clearPendingOpenReap(connectionId)) {
          try {
            peer.close(1001, 'Closed')
          } catch (error) {
            console.error(
              `Failed to close late WebSocket connection ${connectionId}`,
              error,
            )
          }
          return
        }
        this.clients.set(connectionId, peer)
      },
      message: async (peer, message) => {
        const data = message.arrayBuffer().slice() as ArrayBuffer
        try {
          await this.params.onMessage({
            connectionId: peer.context.connectionId,
            data,
          })
        } catch (error) {
          console.error(
            `Error while processing message from ${peer.context.connectionId}`,
            error,
          )
          this.clients.delete(peer.context.connectionId)
          peer.close(1011, 'Internal error')
        }
      },
      error: (peer, error) => {
        console.error(
          `WebSocket error on connection ${peer.context.connectionId}`,
          error,
        )
      },
      close: async (peer) => {
        this.clearPendingOpenReap(peer.context.connectionId)
        this.clients.delete(peer.context.connectionId)
        try {
          await this.params.onDisconnect(peer.context.connectionId)
        } catch (error) {
          console.error(
            `Failed to dispose WebSocket connection ${peer.context.connectionId}`,
            error,
          )
        }
      },
    }) as Hooks
  }

  private schedulePendingOpenReap(connectionId: string) {
    const timer = setTimeout(() => {
      this.pendingOpen.delete(connectionId)
      Promise.resolve(this.params.onDisconnect(connectionId)).catch((error) => {
        console.error(
          `Failed to reap never-opened WebSocket connection ${connectionId}`,
          error,
        )
      })
    }, WS_PENDING_OPEN_TTL)
    this.pendingOpen.set(connectionId, timer)
  }

  // Returns whether the pending entry was claimed by this caller; false
  // means the reap timer already fired (or there was no pending entry)
  private clearPendingOpenReap(connectionId: string) {
    const timer = this.pendingOpen.get(connectionId)
    if (timer === undefined) return false
    this.pendingOpen.delete(connectionId)
    clearTimeout(timer)
    return true
  }

  private createServer() {
    const hooks = this.createWsHooks()
    const opts: WsAdapterParams = { ...this.options, wsHooks: hooks }
    return this.adapterFactory(opts)
  }
}
