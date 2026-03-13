import type { Worker } from 'node:worker_threads'
import { BroadcastChannel } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'
import type {
  DevEnvironmentOptions,
  HotChannel,
  HotChannelClient,
  HotChannelListener,
  HotPayload,
  UserConfig,
} from 'vite'
import {
  createServer as createViteServer,
  DevEnvironment,
  mergeConfig,
} from 'vite'

import type {
  NeemPoolDescriptor,
  NeemPoolEnvironmentHandle,
  NeemPoolEnvironmentOrchestrator,
  NeemPoolHmrUpdate,
  NeemPoolId,
} from '../types.ts'
import { createPoolHmrPlugin } from './plugins.ts'

export interface VitePoolEnvironmentOrchestratorOptions {
  mode: 'development' | 'production'
  logger: Logger
  baseConfig?: UserConfig
  buildPoolConfig?: (
    descriptor: NeemPoolDescriptor,
  ) => UserConfig | Promise<UserConfig>
  environmentDevOptions?: DevEnvironmentOptions
  onPoolHmrUpdate?: (update: NeemPoolHmrUpdate) => void
}

type PoolWorkerClientRegistration = {
  worker: Worker
  channel: BroadcastChannel
  client: HotChannelClient
  onExit: () => void
}

type PoolEnvironmentRecord = {
  descriptor: NeemPoolDescriptor
  handle: NeemPoolEnvironmentHandle
  handlers: Map<string, Set<Function>>
  registrations: Map<number, PoolWorkerClientRegistration>
}

export class VitePoolOrchestrator implements NeemPoolEnvironmentOrchestrator {
  private readonly environments = new Map<NeemPoolId, PoolEnvironmentRecord>()
  private readonly logger: Logger

  constructor(
    private readonly options: VitePoolEnvironmentOrchestratorOptions,
  ) {
    this.logger = options.logger.child({ component: 'VitePoolOrchestrator' })
  }

  async ensurePoolEnvironment(
    descriptor: NeemPoolDescriptor,
  ): Promise<NeemPoolEnvironmentHandle> {
    const existing = this.environments.get(descriptor.id)
    if (existing) return existing.handle

    const environmentName = 'neem'

    const poolConfig =
      (await this.options.buildPoolConfig?.(descriptor)) ??
      descriptor.vite.config ??
      {}

    const handlers = new Map<string, Set<Function>>()

    const config = mergeConfig(
      {
        appType: 'custom',
        clearScreen: false,
        mode: this.options.mode,
        server: { middlewareMode: true, ws: false },
        ssr: { external: ['@nmtjs/neem'] },
        plugins:
          this.options.mode === 'development'
            ? [
                createPoolHmrPlugin({
                  poolId: descriptor.id,
                  environmentName,
                  entrypoints: descriptor.vite.entrypoints ?? [],
                  onUpdate: this.options.onPoolHmrUpdate,
                }),
              ]
            : [],
        environments: {
          [environmentName]: {
            consumer: 'server',
            dev: {
              ...this.options.environmentDevOptions,
              createEnvironment: async (name, config, _context) => {
                const transport: HotChannel = {
                  send: (data: HotPayload) => {
                    const record = this.environments.get(descriptor.id)
                    if (!record) return

                    for (const registration of record.registrations.values()) {
                      registration.channel.postMessage(data)
                    }
                  },
                  on: (event, handler) => {
                    let listeners = handlers.get(event)
                    if (!listeners) {
                      listeners = new Set()
                      handlers.set(event, listeners)
                    }
                    listeners.add(handler)
                  },
                  off: (event, handler) => {
                    if (!handler) {
                      handlers.delete(event)
                      return
                    }

                    const listeners = handlers.get(event)
                    if (!listeners) return
                    listeners.delete(handler)

                    if (listeners.size === 0) {
                      handlers.delete(event)
                    }
                  },
                }

                return new DevEnvironment(name, config, {
                  hot: this.options.mode === 'development',
                  transport,
                })
              },
            },
          },
        },
      } satisfies UserConfig,
      mergeConfig(this.options.baseConfig ?? {}, poolConfig),
    )

    const server = await createViteServer(config)

    const handle: NeemPoolEnvironmentHandle = {
      poolId: descriptor.id,
      server,
      environmentName,
      stop: async () => {
        const record = this.environments.get(descriptor.id)
        if (!record) return

        this.logger.debug(
          { poolId: descriptor.id, environment: environmentName },
          'Stopping Vite pool environment',
        )

        for (const registration of record.registrations.values()) {
          registration.worker.off('exit', registration.onExit)
          registration.channel.onmessage = () => {}
          registration.channel.close()
        }

        this.environments.delete(descriptor.id)
        await server.close()
      },
    }

    this.environments.set(descriptor.id, {
      descriptor,
      handle,
      handlers,
      registrations: new Map(),
    })

    this.logger.debug(
      { poolId: descriptor.id, environment: environmentName },
      'Created Vite pool environment',
    )

    return handle
  }

  getPoolEnvironment(
    poolId: NeemPoolId,
  ): NeemPoolEnvironmentHandle | undefined {
    return this.environments.get(poolId)?.handle
  }

  attachWorker(poolId: NeemPoolId, worker: Worker): void {
    const record = this.environments.get(poolId)
    if (!record) {
      this.logger.warn(
        { poolId, threadId: worker.threadId },
        'Cannot attach worker: pool environment not initialized',
      )
      return
    }

    this.detachWorker(poolId, worker.threadId)

    const channel = createPoolBroadcastChannel(poolId, worker.threadId)
    const client: HotChannelClient = {
      send: (payload: HotPayload) => {
        channel.postMessage(payload)
      },
    }

    channel.onmessage = (event: MessageEvent) => {
      const value = event.data
      if (!value || typeof value.event !== 'string') return

      const listeners = record.handlers.get(value.event)
      if (!listeners?.size) return

      for (const listener of listeners) {
        ;(listener as HotChannelListener)(value.data, client)
      }
    }

    const onExit = () => {
      this.detachWorker(poolId, worker.threadId)
    }

    worker.once('exit', onExit)

    record.registrations.set(worker.threadId, {
      worker,
      channel,
      client,
      onExit,
    })

    const connectListeners = record.handlers.get('vite:client:connect')
    if (connectListeners?.size) {
      for (const listener of connectListeners) {
        ;(listener as HotChannelListener)(undefined, client)
      }
    }

    this.logger.debug(
      { poolId, threadId: worker.threadId },
      'Attached worker to pool Vite environment',
    )
  }

  detachWorker(poolId: NeemPoolId, threadId: number): void {
    const record = this.environments.get(poolId)
    if (!record) return

    const registration = record.registrations.get(threadId)
    if (!registration) return

    registration.worker.off('exit', registration.onExit)

    const disconnectListeners = record.handlers.get('vite:client:disconnect')
    if (disconnectListeners?.size) {
      for (const listener of disconnectListeners) {
        ;(listener as HotChannelListener)(undefined, registration.client)
      }
    }

    registration.channel.onmessage = () => {}
    registration.channel.close()

    record.registrations.delete(threadId)

    this.logger.debug(
      { poolId, threadId },
      'Detached worker from pool Vite environment',
    )
  }

  async stopPoolEnvironment(poolId: NeemPoolId): Promise<void> {
    const handle = this.environments.get(poolId)?.handle
    if (!handle) return
    await handle.stop()
  }

  async stopAll(): Promise<void> {
    const handles = [...this.environments.values()]
      .map((v) => v.handle)
      .reverse()
    for (const handle of handles) await handle.stop()
  }
}

function createPoolBroadcastChannel(
  poolId: NeemPoolId,
  threadId: number,
): BroadcastChannel {
  const normalizedPoolId = poolId
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')

  return new BroadcastChannel(`neem:vite:${normalizedPoolId}:${threadId}`)
}
