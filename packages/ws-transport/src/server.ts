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

export function createWSTransportWorker(
  adapterFactory: WsAdapterServerFactory<any>,
  options: WsTransportOptions,
): TransportWorker<ConnectionType.Bidirectional> {
  return new WsTransportServer(adapterFactory, options)
}

export class WsTransportServer
  implements TransportWorker<ConnectionType.Bidirectional>
{
  #server: WsAdapterServer
  params!: TransportWorkerParams<ConnectionType.Bidirectional>
  clients = new Map<string, Peer>()

  constructor(
    protected readonly adapterFactory: WsAdapterServerFactory<any>,
    protected readonly options: WsTransportOptions,
  ) {
    this.#server = this.createServer()
  }

  async start(
    hooks: TransportWorkerParams<ConnectionType.Bidirectional>,
  ): Promise<string> {
    this.params = hooks
    return await this.#server.start()
  }

  async stop(): Promise<void> {
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

          return { context: { connectionId: connection.id } }
        } catch (error) {
          console.error('Failed to upgrade WebSocket connection', error)
          return InternalServerErrorHttpResponse()
        }
      },
      open: (peer) => {
        const { connectionId } = peer.context
        this.clients.set(connectionId, peer)
      },
      message: async (peer, message) => {
        const data = message.arrayBuffer() as ArrayBuffer
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
        this.clients.delete(peer.context.connectionId)
        try {
          await this.params.onDisconnect({
            connectionId: peer.context.connectionId,
          })
        } catch (error) {
          console.error(
            `Failed to dispose WebSocket connection ${peer.context.connectionId}`,
            error,
          )
        }
      },
    }) as Hooks
  }

  private createServer() {
    const hooks = this.createWsHooks()
    const opts: WsAdapterParams = { ...this.options, wsHooks: hooks }
    return this.adapterFactory(opts)
  }
}
