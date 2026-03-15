import type EventEmitter from 'node:events'
import type { MessagePort, Worker } from 'node:worker_threads'

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
import type { WorkerRegistration } from '../../runtime/server/types.ts'
import type { ViteConfigOptions } from '../config.ts'
import { createConfig } from '../config.ts'
import { plugins } from '../plugins.ts'
import { createServer } from '../server.ts'

export type WorkerServerEventMap = {
  worker: [WorkerRegistration]
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
        const connections = new Map<
          number,
          { worker: Worker; port: MessagePort; client: HotChannelClient }
        >()
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

        events.on('worker', ({ worker, vitePort }) => {
          if (!vitePort) return

          const client: HotChannelClient = {
            send: (payload: HotPayload) => {
              vitePort.postMessage(payload)
            },
          }

          const handleMessage = (value: HotPayload) => {
            if (value.type === 'custom') {
              emit(value.event, value.data, client)
            }
          }

          let disconnected = false
          const disconnect = (closePort: boolean) => {
            if (disconnected) return
            disconnected = true

            emit('vite:client:disconnect', undefined, client)

            vitePort.off('message', handleMessage)
            worker.off('exit', handleWorkerExit)
            vitePort.off('close', handlePortClose)

            if (closePort) {
              vitePort.close()
            }

            connections.delete(worker.threadId)
            clients.delete(worker.threadId)
          }

          const handleWorkerExit = () => disconnect(true)
          const handlePortClose = () => disconnect(false)

          vitePort.on('message', handleMessage)
          worker.once('exit', handleWorkerExit)
          vitePort.once('close', handlePortClose)

          connections.set(worker.threadId, { worker, port: vitePort, client })
          clients.set(worker.threadId, client)

          emit('vite:client:connect', undefined, client)
        })

        const transport: HotChannel = {
          send(data) {
            for (const connection of connections.values()) {
              connection.port.postMessage(data)
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
