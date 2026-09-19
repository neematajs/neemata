import type { DenoAdapter } from 'crossws/adapters/deno'
import createAdapter from 'crossws/adapters/deno'

import type {
  DenoServer,
  ServerHost,
  ServerHostOptions,
  ServerNativeHandles,
} from './types.ts'
import { BaseServerHost } from './host.ts'

// The `Deno` namespace is an optional peer type the repo's tsconfig does not
// load, so the shapes this host depends on are spelled out here. The upgrade
// info is taken from crossws, the only consumer that constrains it.
type ServeInfo = Parameters<DenoAdapter['handleUpgrade']>[1]

type DenoAddr =
  | { transport: 'tcp' | 'udp'; hostname: string; port: number }
  | { transport: 'unix' | 'unixpacket'; path: string }
  | { transport: 'vsock'; cid: number; port: number }

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
        handler: (request: Request, info: ServeInfo) =>
          this.handleRequest(
            request,
            adapter
              ? (upgrade) => adapter.handleUpgrade(upgrade, info)
              : undefined,
          ),
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
      throw new Error('Unsupported address transport')
  }
}

export function createServerHost(
  options: ServerHostOptions<'deno'>,
): ServerHost<'deno'> {
  return new DenoServerHost(options)
}
