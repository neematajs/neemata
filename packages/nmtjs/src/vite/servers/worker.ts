import type EventEmitter from 'node:events'
import type { BroadcastChannel, Worker } from 'node:worker_threads'

import type {
  HotChannel,
  HotChannelClient,
  HotChannelListener,
  HotPayload,
  ViteDevServer,
} from 'vite'
import { DevEnvironment } from 'vite'

import type { NeemataConfig } from '../../config.ts'
import type { ViteConfigOptions } from '../config.ts'
import { createConfig } from '../config.ts'
import { buildPlugins } from '../plugins.ts'
import { createBroadcastChannel } from '../runners/worker.ts'
import { createServer } from '../server.ts'

export type WorkerServerEventMap = {
  worker: [Worker]
  'worker-error': [unknown]
  'worker-ready': [unknown]
}

export async function createWorkerServer(
  options: ViteConfigOptions,
  mode: 'development' | 'production',
  neemataConfig: NeemataConfig,
  events: EventEmitter<WorkerServerEventMap>,
): Promise<ViteDevServer> {
  const config = createConfig(options)
  const applicationEntries = Object.values(options.applicationImports).map(
    (v) => v.path,
  )

  const _injectHmr = `\n\nif(import.meta.hot) { import.meta.hot.accept(globalThis._hotAccept) }`

  const server = await createServer(
    options,
    {
      appType: 'custom',
      clearScreen: false,
      resolve: { alias: config.alias },
      mode,
      plugins: [
        ...buildPlugins,
        ...neemataConfig.plugins,
        mode === 'development'
          ? [
              {
                name: 'neemata-worker-application-hmr',
                transform(code, id, options) {
                  if (applicationEntries.includes(id)) {
                    return code + _injectHmr
                  }
                },
              },
            ]
          : [],
      ],
    },
    {
      createEnvironment: async (name, config, context) => {
        const channels = new Map<number, BroadcastChannel>()
        const clients = new Map<BroadcastChannel, HotChannelClient>()
        const handlers = new Map<string, HotChannelListener>()

        events.on('worker', (worker) => {
          const channel = createBroadcastChannel(worker.threadId)
          channel.onmessage = (event) => {
            const value = event.data
            const handler = handlers.get(value.event)
            if (handler) handler(value.data, client)
          }
          channels.set(worker.threadId, channel)
          const client = {
            send: (payload: HotPayload) => {
              channel.postMessage(payload)
            },
          }
          clients.set(channel, client)
          worker.on('exit', () => {
            const handler = handlers.get('vite:client:disconnect')
            if (handler) handler(undefined, client)
          })
        })

        const transport: HotChannel = {
          send(data) {
            for (const channel of channels.values()) {
              channel.postMessage(data)
            }
          },
          on(event, handler) {
            handlers.set(event, handler)
          },
          off(event) {
            handlers.delete(event)
          },
        }

        let lastError: any

        events.on('worker-error', (payload: any) => {
          lastError = payload?.error ?? payload
          const error =
            lastError instanceof Error
              ? lastError
              : new Error(String(lastError))
          const message = {
            type: 'error',
            err: {
              message: error.message,
              stack: error.stack ?? '',
              plugin: 'neemata:worker',
            },
          } satisfies HotPayload
          for (const client of clients.values()) {
            client.send(message)
          }
        })

        events.on('worker-ready', () => {
          if (!lastError) return
          lastError = undefined
          const message: HotPayload = { type: 'full-reload' }
          for (const client of clients.values()) {
            client.send(message)
          }
        })

        const environment = new DevEnvironment(name, config, {
          hot: mode === 'development',
          transport,
        })

        return environment
      },
    },
  )
  return server
}
