import createAdapter from 'crossws/adapters/deno'

import type {
  DenoServer,
  ServerHost,
  ServerHostOptions,
  ServerNativeHandles,
} from '../types.ts'
import { BaseServerHost } from '../host.ts'

interface DenoNetAddr {
  transport: 'tcp' | 'udp'
  hostname: string
  port: number
}

interface DenoUnixAddr {
  transport: 'unix' | 'unixpacket'
  path: string
}

interface DenoVsockAddr {
  transport: 'vsock'
  cid: number
  port: number
}

type DenoAddr = DenoNetAddr | DenoUnixAddr | DenoVsockAddr

class DenoServerHost extends BaseServerHost<'deno'> {
  readonly runtime = 'deno' as const
  #server: DenoServer | null = null

  get native(): ServerNativeHandles {
    return { deno: this.#server ?? undefined }
  }

  protected bind(): Promise<string> {
    const { listen, tls } = this.options
    const adapter = this.hasWebSockets
      ? createAdapter(this.createWsAdapterConfig())
      : null

    const listenOptions = listen.unix
      ? { path: listen.unix }
      : {
          port: listen.port,
          hostname: listen.hostname,
          reusePort: listen.reusePort,
        }
    const options = {
      ...listenOptions,
      tls: tls
        ? {
            cert: tls.cert,
            key: tls.key,
            passphrase: tls.passphrase,
          }
        : undefined,
    }

    return new Promise<string>((resolve) => {
      const server = globalThis.Deno.serve({
        ...this.options.runtime,
        ...options,
        handler: async (request: Request, info: any) => {
          const url = new URL(request.url)
          if (request.headers.get('upgrade') === 'websocket') {
            if (!adapter) return this.respondToUpgrade(url.pathname)
            return await adapter.handleUpgrade(request, info as any)
          }
          return await this.dispatchFetch(request)
        },
        onListen: (addr: DenoAddr) => {
          this.#server = server
          setTimeout(() => {
            resolve(formatDenoUrl(addr, Boolean(tls)))
          }, 1)
        },
      })
    })
  }

  protected async close(): Promise<void> {
    const server = this.#server
    this.#server = null
    if (server) await server.shutdown()
  }
}

function formatDenoUrl(addr: DenoAddr, secure: boolean): string {
  const proto = secure ? 'https' : 'http'
  switch (addr.transport) {
    case 'unix':
    case 'unixpacket':
      return `${proto}+unix://${addr.path}`
    case 'tcp':
    case 'udp':
      return `${proto}://${addr.hostname}:${addr.port}`
    case 'vsock':
      return `vsock://${addr.cid}:${addr.port}`
    default:
      throw new Error(`Unsupported address transport`)
  }
}

export function createServerHost(
  options: ServerHostOptions<'deno'>,
): ServerHost<'deno'> {
  return new DenoServerHost(options)
}
