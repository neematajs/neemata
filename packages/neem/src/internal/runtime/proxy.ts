import { OperationQueue } from '@nmtjs/common'

import type { NeemProxyConfig } from '../../public/config.ts'
import type { NeemProxyHealth } from '../../public/runtime.ts'
import type {
  NeemProxyUpstream,
  NeemProxyUpstreamRegistry,
  NeemProxyUpstreamRegistryEvent,
} from './proxy-upstreams.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import { createNeemChildLogger } from './logger.ts'
import { getProxyRuntimeUpstreamKey } from './proxy-upstreams.ts'

export type { NeemProxyHealth } from '../../public/runtime.ts'
export * from './proxy-upstreams.ts'

export type NeemProxyManagerOptions = {
  snapshot: NeemRuntimeSnapshot
  upstreams: NeemProxyUpstreamRegistry
}

export type NeemNativeProxy = {
  start: () => Promise<void>
  stop: () => Promise<void>
  addUpstream: (
    runtimeName: string,
    upstream: NeemProxyUpstream,
  ) => Promise<void>
  removeUpstream: (
    runtimeName: string,
    upstream: NeemProxyUpstream,
  ) => Promise<void>
}

export type NeemNativeProxyOptions = {
  listen: string
  tls?: { keyPath: string; certPath: string }
  // @nmtjs/proxy still names route groups "applications"; Neem maps runtimes into that native shape.
  applications: Array<{
    name: string
    routing: { type?: 'subdomain' | 'path'; name?: string; default?: boolean }
    sni?: string
  }>
  healthCheckIntervalMs?: number
  stickySessions?: NeemProxyConfig['stickySessions']
}

type NeemNativeProxyConstructor = new (
  options: NeemNativeProxyOptions,
) => NeemNativeProxy

export class NeemProxyManager {
  private readonly logger: NeemRuntimeSnapshot['logger']
  private readonly config: NeemProxyConfig
  private proxy: NeemNativeProxy | undefined
  private running = false
  private offAdd: (() => void) | undefined
  private offRemove: (() => void) | undefined
  private readonly mutations = new OperationQueue()
  private mutationError: Error | undefined
  private readonly applied = new Map<string, NeemProxyUpstreamRegistryEvent>()
  private readonly failures = new Map<
    string,
    {
      operation: 'add' | 'remove'
      upstream: NeemProxyUpstreamRegistryEvent
      error: Error
    }
  >()

  constructor(private readonly options: NeemProxyManagerOptions) {
    const config = options.snapshot.config.proxy
    if (!config) throw new Error('Cannot create Neem proxy without config')

    this.config = config
    this.logger = createNeemChildLogger(options.snapshot.logger, 'neem:proxy')
  }

  async start(): Promise<void> {
    if (this.proxy) return

    const ProxyConstructor = (await loadProxyPackage()).Proxy
    this.proxy = new ProxyConstructor(
      createNativeProxyOptions(
        this.config,
        Object.keys(this.options.snapshot.manifest.runtimes ?? {}),
      ),
    )

    this.offAdd = this.options.upstreams.on('add', (event) => {
      this.enqueueMutation(() => this.addUpstream(event))
    })
    this.offRemove = this.options.upstreams.on('remove', (event) => {
      this.enqueueMutation(() => this.removeUpstream(event))
    })

    try {
      for (const event of this.options.upstreams.list()) {
        await this.addUpstream(event)
      }

      this.logger.info(
        {
          hostname: this.config.hostname,
          port: this.config.port,
          runtimes: Object.keys(this.options.snapshot.manifest.runtimes ?? {}),
        },
        'Starting Neem proxy',
      )
      await this.proxy.start()
      this.running = true
      this.logger.info('Neem proxy started')
    } catch (error) {
      const proxy = this.proxy
      this.offAdd?.()
      this.offRemove?.()
      this.offAdd = undefined
      this.offRemove = undefined
      this.proxy = undefined
      this.running = false
      this.applied.clear()
      await this.waitForIdle().catch(() => undefined)
      await proxy?.stop().catch(() => undefined)
      throw error
    }
  }

  async stop(): Promise<void> {
    const proxy = this.proxy
    this.offAdd?.()
    this.offRemove?.()
    this.offAdd = undefined
    this.offRemove = undefined
    this.running = false

    if (!proxy) return
    await this.waitForIdle().catch((error) => {
      this.logger.warn(
        new Error('Failed to drain proxy upstream mutations before stop', {
          cause: error,
        }),
      )
    })
    this.proxy = undefined
    this.applied.clear()
    this.failures.clear()
    this.logger.info('Stopping Neem proxy')
    await proxy.stop()
    this.logger.info('Neem proxy stopped')
  }

  async waitForIdle(): Promise<void> {
    await this.mutations.waitIdle()

    const error = this.mutationError
    this.mutationError = undefined
    if (error) throw error
  }

  async waitForSync(): Promise<void> {
    await this.waitForIdle()
  }

  getHealth(): NeemProxyHealth {
    const desired = [...this.options.upstreams.list()]
    const applied = [...this.applied.values()]
    const failedUpstreams = [...this.failures.values()]
    const lastError = failedUpstreams.at(-1)?.error
    const synced =
      desired.length === applied.length &&
      desired.every((event) => this.applied.has(getRegistryEventKey(event)))
    return {
      enabled: true,
      running: this.running,
      ready:
        this.running &&
        this.mutations.pending === 0 &&
        failedUpstreams.length === 0 &&
        synced,
      upstreams: desired,
      appliedUpstreams: applied,
      pending: this.mutations.pending,
      failedUpstreams,
      lastError,
    }
  }

  private async addUpstream(
    event: NeemProxyUpstreamRegistryEvent,
  ): Promise<void> {
    if (!this.proxy) return
    const key = getRegistryEventKey(event)
    try {
      await this.proxy.addUpstream(event.runtimeName, event.proxyUpstream)
      this.applied.set(key, event)
      this.failures.delete(key)
    } catch (error) {
      const normalized = toError(error)
      this.failures.set(key, {
        operation: 'add',
        upstream: event,
        error: normalized,
      })
      throw normalized
    }
  }

  private async removeUpstream(
    event: NeemProxyUpstreamRegistryEvent,
  ): Promise<void> {
    if (!this.proxy) return
    const key = getRegistryEventKey(event)
    try {
      await this.proxy.removeUpstream(event.runtimeName, event.proxyUpstream)
      this.applied.delete(key)
      this.failures.delete(key)
    } catch (error) {
      const normalized = toError(error)
      this.failures.set(key, {
        operation: 'remove',
        upstream: event,
        error: normalized,
      })
      throw normalized
    }
  }

  private enqueueMutation(task: () => Promise<void>): void {
    void this.mutations
      .run(async () => {
        try {
          await task()
        } catch (error) {
          const normalized = toError(error)
          this.mutationError ??= normalized
          this.logger.warn(
            new Error('Failed to apply proxy upstream mutation', {
              cause: normalized,
            }),
          )
        }
      })
      .catch((error) => {
        const normalized = toError(error)
        this.mutationError ??= normalized
        this.logger.warn(
          new Error('Failed to apply proxy upstream mutation', {
            cause: normalized,
          }),
        )
      })
  }
}

export function createNativeProxyOptions(
  config: NeemProxyConfig,
  runtimeNames: readonly string[],
): NeemNativeProxyOptions {
  const configured = config.runtimes ?? {}
  const active = new Set(runtimeNames)
  const names =
    Object.keys(configured).length > 0
      ? Object.keys(configured).filter((name) => active.has(name))
      : runtimeNames

  return {
    listen: `${config.hostname}:${config.port}`,
    tls: config.tls
      ? { keyPath: config.tls.key, certPath: config.tls.cert }
      : undefined,
    applications: names.flatMap((name) => {
      const runtime = configured[name]
      if (runtime === undefined && Object.keys(configured).length > 0) return []
      return [
        {
          name,
          routing: runtime?.routing ?? { type: 'path', name },
          sni: runtime?.sni,
        },
      ]
    }),
    healthCheckIntervalMs: config.healthChecks?.interval,
    stickySessions: config.stickySessions,
  }
}

async function loadProxyPackage() {
  return (await import(
    process.env.NEEM_INTERNAL_PROXY_MODULE || '@nmtjs/proxy'
  )) as { Proxy: NeemNativeProxyConstructor }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function getRegistryEventKey(event: NeemProxyUpstreamRegistryEvent): string {
  return `${event.runtimeName}:${getProxyRuntimeUpstreamKey(event.upstream)}`
}
