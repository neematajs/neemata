import type { Hooks } from 'crossws'

import type {
  ServerFetchHandler,
  ServerFetchRegistration,
  ServerHost,
  ServerHostOptions,
  ServerNativeHandles,
  ServerRuntimeName,
  ServerWebSocketRegistration,
} from './types.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
  OkResponse,
} from './utils.ts'

export const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024 * 128 // 128MiB

/**
 * Paths the host answers itself on every runtime; handlers cannot claim
 * them, and both plain requests and upgrade attempts get the reserved
 * response. Kept in one table so adding a reserved path cannot be forgotten
 * on one of the mount/dispatch/upgrade layers.
 */
const RESERVED_PATHS: ReadonlyMap<string, () => Response> = new Map([
  ['/healthy', OkResponse],
])

/**
 * The routing decision for one pathname. Produced only by
 * `BaseServerHost.route` — the single place where reserved paths, WebSocket
 * vs fetch precedence, longest-prefix matching and 404s are decided, for
 * every runtime.
 */
export type ServerRoute =
  | { kind: 'reserved'; respond: () => Response }
  | { kind: 'fetch'; handler: ServerFetchHandler }
  | { kind: 'upgrade'; registration: ServerWebSocketRegistration }
  | { kind: 'none' }

export abstract class BaseServerHost<
  R extends ServerRuntimeName,
> implements ServerHost<R> {
  abstract readonly runtime: R
  readonly #fetchHandlers = new Map<string, ServerFetchRegistration>()
  readonly #webSockets = new Map<string, ServerWebSocketRegistration>()
  #bound: Promise<string> | null = null
  #closing: Promise<void> | null = null

  constructor(protected readonly options: ServerHostOptions<R>) {}

  abstract get native(): ServerNativeHandles

  mountFetchHandler(registration: ServerFetchRegistration): () => void {
    this.assertCanMount('fetch', registration.path)
    if (this.#fetchHandlers.has(registration.path)) {
      throw new Error(
        `A fetch handler is already mounted on [${registration.path}]`,
      )
    }
    this.#fetchHandlers.set(registration.path, registration)
    return () => {
      if (this.#fetchHandlers.get(registration.path) === registration) {
        this.#fetchHandlers.delete(registration.path)
      }
    }
  }

  mountWebSocket(registration: ServerWebSocketRegistration): () => void {
    this.assertCanMount('WebSocket', registration.path)
    if (this.#webSockets.has(registration.path)) {
      throw new Error(
        `A WebSocket handler is already mounted on [${registration.path}]`,
      )
    }
    this.#webSockets.set(registration.path, registration)
    return () => {
      if (this.#webSockets.get(registration.path) === registration) {
        this.#webSockets.delete(registration.path)
      }
    }
  }

  isSendSuccess(_status: number): boolean {
    return true
  }

  async start(): Promise<string> {
    this.#validateWebSocketRequirements()
    // a rebind must not race a close() still tearing the old socket down
    if (this.#closing) await this.#closing.catch(() => undefined)
    const bound = (this.#bound ??= this.bind())
    try {
      return await bound
    } catch (error) {
      if (this.#bound === bound) this.#bound = null
      throw error
    }
  }

  async stop(): Promise<void> {
    const bound = this.#bound
    if (!bound) return
    await bound.catch(() => undefined)
    if (this.#bound !== bound) return
    this.#bound = null
    this.#closing = Promise.resolve(this.close())
    try {
      await this.#closing
    } finally {
      this.#closing = null
    }
  }

  get maxRequestBodySize(): number {
    return this.options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE
  }

  protected get hasWebSockets(): boolean {
    return this.#webSockets.size > 0
  }

  /**
   * Effective inbound WebSocket frame cap after runtime defaults are
   * applied; undefined means the runtime imposes no cap. Each runtime host
   * reports its own so requirement validation sees the real value, not just
   * the user-provided option.
   */
  protected get effectiveWsMaxPayloadLength(): number | undefined {
    return undefined
  }

  /**
   * The single routing decision point shared by every runtime and both
   * request kinds (plain and upgrade).
   */
  protected route(pathname: string, upgrade: boolean): ServerRoute {
    const reserved = RESERVED_PATHS.get(pathname)
    if (reserved) return { kind: 'reserved', respond: reserved }
    if (upgrade) {
      const registration = this.matchPath(this.#webSockets, pathname)
      return registration ? { kind: 'upgrade', registration } : { kind: 'none' }
    }
    const registration = this.matchPath(this.#fetchHandlers, pathname)
    return registration
      ? { kind: 'fetch', handler: registration.handler }
      : { kind: 'none' }
  }

  /**
   * Full pipeline for plain requests on Request/Response runtimes; the uWS
   * host reuses route() and shapes the response itself.
   */
  protected async dispatchFetch(request: Request): Promise<Response> {
    const route = this.route(new URL(request.url).pathname, false)
    if (route.kind === 'reserved') return route.respond()
    if (route.kind !== 'fetch') return NotFoundHttpResponse()
    try {
      return await route.handler(request)
    } catch (err) {
      // TODO: proper logging
      console.error(err)
      return InternalServerErrorHttpResponse()
    }
  }

  /**
   * Answer for an upgrade request no WebSocket route can take (none mounted,
   * or the runtime routed it to plain HTTP handling): reserved paths still
   * respond, everything else is a 404 — identical to the adapter hook's
   * decisions because both call route().
   */
  protected respondToUpgrade(pathname: string): Response {
    const route = this.route(pathname, true)
    if (route.kind === 'reserved') return route.respond()
    return NotFoundHttpResponse()
  }

  /**
   * Runtime-agnostic crossws adapter config: the global upgrade gate and
   * per-connection hook resolution both defer to route(), so upgrade
   * behavior is decided in exactly one place.
   */
  protected createWsAdapterConfig(): {
    hooks: Partial<Hooks>
    resolve: (request: Request | { url: string }) => Partial<Hooks>
  } {
    return {
      hooks: {
        upgrade: (request: Request) => {
          const route = this.route(new URL(request.url).pathname, true)
          if (route.kind === 'reserved') return route.respond()
          if (route.kind === 'upgrade') return undefined
          return NotFoundHttpResponse()
        },
      } as Partial<Hooks>,
      resolve: (request) => {
        const route = this.route(new URL(request.url).pathname, true)
        return route.kind === 'upgrade' ? route.registration.hooks : {}
      },
    }
  }

  private matchPath<T extends { path: string }>(
    registrations: Map<string, T>,
    pathname: string,
  ): T | undefined {
    let match: T | undefined
    for (const [path, registration] of registrations) {
      const matches =
        path === '/' || pathname === path || pathname.startsWith(`${path}/`)
      if (matches && (!match || path.length > match.path.length)) {
        match = registration
      }
    }
    return match
  }

  private assertCanMount(kind: string, path: string): void {
    if (this.#bound) {
      throw new Error(`Cannot mount a ${kind} handler on a started server`)
    }
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
      throw new Error('A handler path must be an absolute URL pathname')
    }
    if (path.length > 1 && path.endsWith('/')) {
      throw new Error('A handler path must not have a trailing slash')
    }
    if (RESERVED_PATHS.has(path)) {
      throw new Error(`The ${path} path is owned by the server host`)
    }
  }

  #validateWebSocketRequirements(): void {
    const cap = this.effectiveWsMaxPayloadLength
    if (cap === undefined) return
    for (const [path, registration] of this.#webSockets) {
      const min = registration.requirements?.minPayloadLength
      if (min !== undefined && cap < min) {
        throw new Error(
          `The WebSocket handler on [${path}] requires maxPayloadLength >= ${min}, ` +
            `but the host is configured with ${cap}`,
        )
      }
    }
  }

  /**
   * Materialize the runtime server from the collected registrations, bind
   * the socket and resolve with the bound URL.
   */
  protected abstract bind(): Promise<string>
  protected abstract close(): Promise<void>
}
