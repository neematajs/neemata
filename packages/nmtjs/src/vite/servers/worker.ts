import type EventEmitter from 'node:events'
import type { BroadcastChannel, Worker } from 'node:worker_threads'

import type {
  HotChannel,
  HotChannelClient,
  HotChannelListener,
  HotPayload,
  Plugin,
  UserConfig,
  ViteDevServer,
} from 'vite'
import { DevEnvironment, mergeConfig } from 'vite'

import type { NeemataConfig } from '../../config.ts'
import type { ViteConfigOptions } from '../config.ts'
import { createConfig } from '../config.ts'
import { plugins } from '../plugins.ts'
import { createBroadcastChannel } from '../runners/worker.ts'
import { createServer } from '../server.ts'

export type WorkerServerEventMap = {
  worker: [Worker]
  /** Emitted when an HMR update occurs for an application file (useful for restarting dead workers) */
  'hmr-update': [{ file: string }]
}

export async function createViteServer(
  options: ViteConfigOptions,
  mode: 'development' | 'production',
  neemataConfig: NeemataConfig,
  events: EventEmitter<WorkerServerEventMap>,
): Promise<ViteDevServer> {
  const config = createConfig(options)
  const applicationEntries = Object.values(options.applicationImports).map(
    (v) => v.path,
  )

  const _injectHmr = `\n\nif(import.meta.hot) { import.meta.hot.accept((module) => globalThis._hotAccept?.(module)) }`

  const server = await createServer(
    options,
    mergeConfig(neemataConfig.vite, {
      appType: 'custom',
      clearScreen: false,
      resolve: { alias: config.alias, external: ['@nmtjs/proxy'] },
      mode,
      optimizeDeps: { noDiscovery: true },
      plugins: [
        ...plugins,
        ...(mode === 'development'
          ? [
              {
                name: 'neemata-worker-application-hmr',
                transform(code, id, _options) {
                  if (applicationEntries.includes(id)) {
                    return code + _injectHmr
                  }
                },
                handleHotUpdate(ctx) {
                  // Emit event when application entry files change
                  // This allows restarting failed workers after code fixes
                  if (ctx.file && applicationEntries.includes(ctx.file)) {
                    events.emit('hmr-update', { file: ctx.file })
                  }
                },
              } satisfies Plugin,
            ]
          : []),
      ],
    } satisfies UserConfig),
    {
      createEnvironment: async (name, config, context) => {
        const channels = new Map<number, BroadcastChannel>()
        const clients = new Map<number, HotChannelClient>()
        const handlers = new Map<string, Set<Function>>()

        const emit = (
          event: string,
          data: unknown,
          client: HotChannelClient,
        ) => {
          const listeners = handlers.get(event)
          if (!listeners?.size) return
          for (const listener of listeners) {
            ;(listener as HotChannelListener)(data, client)
          }
        }

        events.on('worker', (worker) => {
          const channel = createBroadcastChannel(worker.threadId)
          const client: HotChannelClient = {
            send: (payload: HotPayload) => {
              channel.postMessage(payload)
            },
          }

          channel.onmessage = (event) => {
            const value = event.data
            if (value && typeof value.event === 'string') {
              emit(value.event, value.data, client)
            }
          }

          channels.set(worker.threadId, channel)
          clients.set(worker.threadId, client)

          emit('vite:client:connect', undefined, client)

          worker.once('exit', () => {
            emit('vite:client:disconnect', undefined, client)

            channel.onmessage = () => {}
            channel.close()
            channels.delete(worker.threadId)
            clients.delete(worker.threadId)
          })
        })

        const transport: HotChannel = {
          send(data) {
            for (const channel of channels.values()) {
              channel.postMessage(data)
            }
          },
          on(event, handler) {
            let listeners = handlers.get(event)
            if (!listeners) {
              listeners = new Set()
              handlers.set(event, listeners)
            }
            listeners.add(handler)
          },
          off(event, handler) {
            if (!handler) {
              handlers.delete(event)
              return
            }

            const listeners = handlers.get(event)
            if (!listeners) return
            listeners.delete(handler)
            if (!listeners.size) {
              handlers.delete(event)
            }
          },
        }

        return new DevEnvironment(name, config, {
          hot: mode === 'development',
          transport,
        })
      },
    },
  )
  return server
}
