import type {
  GatewayResolvedProcedure,
  TransportWorkerParams,
} from '@nmtjs/gateway'
import type { ProtocolFormats, SendResult } from '@nmtjs/protocol/server'
import type { Hooks, Peer } from 'crossws'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { ProtocolVersion } from '@nmtjs/protocol'
import { getFormat } from '@nmtjs/protocol/server'
import { defineHooks } from 'crossws'

import type { ServerHandler } from '../transport.ts'
import type { ServerHost } from '../types.ts'
import type {
  NeemataWebSocketHandlerOptions,
  NeemataWebSocketRequest,
} from './types.ts'
import * as injections from './injectables.ts'
import { WsSessionEngine } from './session.ts'
import { InternalServerErrorHttpResponse } from './utils.ts'

/**
 * How long an upgraded connection may stay without its `open` hook firing
 * before it is reaped. Sockets that die between upgrade and open never get a
 * `close` hook, which would leak the gateway connection and its container.
 */
export const WS_PENDING_OPEN_TTL = 10_000

/**
 * Smallest inbound frame the Neemata protocol needs the host to accept: the
 * session engine grants upload credits in 64KiB chunks, and each frame
 * carries a small protocol header on top. Declared as a registration
 * requirement so a host-wide `webSocket.maxPayloadLength` below it fails at
 * start instead of killing every blob upload at runtime.
 */
export const WS_MIN_INBOUND_PAYLOAD = 64 * 1024 + 1024

type OnDisconnect = (connectionId: string) => Promise<void>

/**
 * Single owner of connection teardown. Every path that ends a connection —
 * reap timer, crossws close hook, session-initiated termination (heartbeat
 * timeout, dropped terminal frames), handler dispose — goes through
 * disconnect(), which claims the connection from whichever map holds it
 * before acting; a second caller finds nothing to claim and no-ops.
 * Exactly-once delivery of onDisconnect is therefore structural, not a
 * convention each call site must remember.
 */
class WsConnectionRegistry {
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #open = new Map<string, Peer>()

  constructor(private readonly onDisconnect: OnDisconnect) {}

  /** Track an upgraded-but-not-yet-opened connection; reaped after the TTL. */
  admit(connectionId: string): void {
    const timer = setTimeout(() => {
      void this.disconnect(connectionId)
    }, WS_PENDING_OPEN_TTL)
    this.#pending.set(connectionId, timer)
  }

  /**
   * Claim a pending connection for its opened peer. Returns false when the
   * reap (or a disconnect) already claimed it — the late peer must be
   * closed by the caller instead of registered as a zombie.
   */
  opened(connectionId: string, peer: Peer): boolean {
    if (!this.#claimPending(connectionId)) return false
    this.#open.set(connectionId, peer)
    return true
  }

  peer(connectionId: string): Peer | undefined {
    return this.#open.get(connectionId)
  }

  async disconnect(
    connectionId: string,
    close?: { code?: number; reason?: string },
  ): Promise<void> {
    if (!this.#claim(connectionId, close)) return
    try {
      await this.onDisconnect(connectionId)
    } catch (error) {
      console.error(
        `Failed to dispose WebSocket connection ${connectionId}`,
        error,
      )
    }
  }

  #claim(
    connectionId: string,
    close?: { code?: number; reason?: string },
  ): boolean {
    const pending = this.#claimPending(connectionId)
    const peer = this.#open.get(connectionId)
    if (peer) this.#open.delete(connectionId)
    // nothing claimed: teardown already ran (or the id was never admitted)
    if (!pending && !peer) return false
    if (peer && close) {
      try {
        peer.close(close.code ?? 1001, close.reason ?? 'Closed')
      } catch (error) {
        console.error(
          `Failed to close WebSocket connection ${connectionId}`,
          error,
        )
      }
    }
    return true
  }

  async disposeAll(close: { code: number; reason: string }): Promise<void> {
    const ids = new Set([...this.#pending.keys(), ...this.#open.keys()])
    for (const connectionId of ids) {
      await this.disconnect(connectionId, close)
    }
  }

  #claimPending(connectionId: string): boolean {
    const timer = this.#pending.get(connectionId)
    if (timer === undefined) return false
    this.#pending.delete(connectionId)
    clearTimeout(timer)
    return true
  }
}

export function neemataWebSocket(): ServerHandler<
  NeemataWebSocketHandlerOptions,
  typeof injections,
  readonly [ProxyableTransportType.WS],
  GatewayResolvedProcedure
> {
  return {
    proxyable: [ProxyableTransportType.WS],
    injectables: injections,
    mount({ host, gateway }, options) {
      const handler = new NeemataWebSocketHandler(gateway, host, options)
      handler.unmount = host.mountWebSocket({
        path: options.path,
        hooks: handler.hooks,
        requirements: { minPayloadLength: WS_MIN_INBOUND_PAYLOAD },
      })
      return handler
    },
  }
}

export class NeemataWebSocketHandler {
  readonly connections: WsConnectionRegistry
  readonly engine: WsSessionEngine
  readonly hooks: Hooks
  readonly #formats: ProtocolFormats
  unmount: () => void = () => {}
  #disposed = false
  #pendingUpgrades = new Set<Promise<unknown>>()

  constructor(
    readonly params: TransportWorkerParams<GatewayResolvedProcedure>,
    readonly host: ServerHost,
    readonly options: NeemataWebSocketHandlerOptions,
  ) {
    this.#formats = options.formats
    this.connections = new WsConnectionRegistry(async (connectionId) => {
      // wire state first, so in-flight calls observe their wire aborts
      // before the gateway aborts and disposes the application scope
      this.engine.close(connectionId)
      await this.params.onDisconnect(connectionId)
    })
    this.engine = new WsSessionEngine(this.params, {
      streamIdleTimeout: options.streamIdleTimeout,
      heartbeat: options.heartbeat,
      send: this.send.bind(this),
      terminate: (connectionId, close) =>
        this.connections.disconnect(connectionId, close),
    })
    this.hooks = this.createHooks()
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    this.unmount()
    // upgrades whose onConnect is in flight either register before the sweep
    // below or observe #disposed and self-clean — no admission can slip past
    await Promise.allSettled(this.#pendingUpgrades)
    await this.connections.disposeAll({ code: 1001, reason: 'Handler stopped' })
  }

  send(connectionId: string, buffer: ArrayBufferView): SendResult {
    const peer = this.connections.peer(connectionId)
    if (!peer) return 'dropped'

    try {
      const result = peer.send(buffer)
      if (typeof result === 'boolean') {
        return result ? 'delivered' : 'dropped'
      }
      if (typeof result === 'number') {
        return this.host.isSendSuccess(result) ? 'delivered' : 'dropped'
      }
      // runtimes with a void send (Deno) give no delivery feedback; this
      // must not read as a drop or every send would abort streams
      return 'unknown'
    } catch (error) {
      console.error(
        `Failed to send data over WebSocket connection ${connectionId}`,
        error,
      )
      return 'dropped'
    }
  }

  private createHooks(): Hooks {
    return defineHooks({
      upgrade: (req) => {
        const upgrade = this.upgrade(req)
        this.#pendingUpgrades.add(upgrade)
        return upgrade.finally(() => this.#pendingUpgrades.delete(upgrade))
      },
      open: (peer) => {
        const { connectionId } = peer.context
        // the reap (or dispose) already claimed this connection — the
        // gateway side is gone, close the late peer instead of registering
        // a zombie
        if (!this.connections.opened(connectionId, peer)) {
          try {
            peer.close(1001, 'Closed')
          } catch (error) {
            console.error(
              `Failed to close late WebSocket connection ${connectionId}`,
              error,
            )
          }
        }
      },
      message: async (peer, message) => {
        const data = message.arrayBuffer().slice() as ArrayBuffer
        try {
          await this.engine.receive(peer.context.connectionId, data)
        } catch (error) {
          console.error(
            `Error while processing message from ${peer.context.connectionId}`,
            error,
          )
          // close the socket only: the close hook owns the disconnect, so
          // removing state here would orphan the gateway connection
          peer.close(1011, 'Internal error')
        }
      },
      error: (peer, error) => {
        console.error(
          `WebSocket error on connection ${peer.context.connectionId}`,
          error,
        )
      },
      close: (peer) => {
        return this.connections.disconnect(peer.context.connectionId)
      },
    }) as Hooks
  }

  private async upgrade(req: Parameters<NonNullable<Hooks['upgrade']>>[0]) {
    const request: NeemataWebSocketRequest = new Request(req.url, {
      headers: req.headers,
      method: req.method,
      // Preserve disconnect propagation while materializing crossws' request
      // proxy as a standards-compliant Request for application consumers.
      signal: req.signal,
    })
    const url = new URL(request.url)
    const accept = url.searchParams.get('accept') ?? req.headers.get('accept')
    const contentType =
      url.searchParams.get('content-type') ?? req.headers.get('content-type')

    try {
      // the handler owns codec negotiation: an unsupported accept or
      // content-type fails the upgrade before any gateway state exists
      const { encoder, decoder } = getFormat(this.#formats, {
        accept,
        contentType,
      })

      const connection = await this.params.onConnect({ data: request })
      if (this.#disposed) {
        // never admitted to the registry, so the gateway connection is
        // released directly; the gateway absorbs any duplicate
        await this.params.onDisconnect(connection.id)
        return InternalServerErrorHttpResponse()
      }
      this.engine.open(connection, {
        protocolVersion: ProtocolVersion.v1,
        encoder,
        decoder,
      })
      this.connections.admit(connection.id)
      return { context: { connectionId: connection.id } }
    } catch (error) {
      console.error('Failed to upgrade WebSocket connection', error)
      return InternalServerErrorHttpResponse()
    }
  }
}
