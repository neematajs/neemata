import type { Server } from 'node:http'
import { createServer } from 'node:http'

import type {
  ConsolaLike,
  ConsolaLogObject,
  NuxtInstance,
} from '../nuxt-loader.ts'
import type {
  NeemNuxtRuntimeFactory,
  NeemNuxtWorkerContext,
  NodeHandler,
} from '../types.ts'
import { assertRoutingBase, normalizeBase, restoreBase } from '../base.ts'
import {
  importConsolaFrom,
  importH3From,
  importKitFrom,
  shimWorkerUmask,
} from '../nuxt-loader.ts'
import { closeServer, listenLoopback } from '../server.ts'

/**
 * Development implementation behind `neem-nuxt:impl`: runs Nuxt's dev
 * pipeline (loadNuxt + buildNuxt, the same entry points nuxt/cli uses)
 * inside the runtime worker thread. Ownership is inverted relative to the
 * vite preset: Nuxt never binds a port — the worker creates the listener
 * first and Nuxt attaches to it via the `listen` hook, so Vite's HMR
 * WebSocket shares the worker's port and no port-defense tripwires are
 * needed. Neem's watcher never sees the app source — Nuxt owns that module
 * graph, its watchers, and HMR.
 */
const createNuxtDevRuntime: NeemNuxtRuntimeFactory = (ctx, options) => {
  let nuxt: NuxtInstance | undefined
  let server: Server | undefined
  let stopping = false
  const { promise: finished, reject: fail } = Promise.withResolvers<void>()
  void finished.catch(() => {})

  return {
    finished,
    async start() {
      if (options.mode !== 'dev') {
        throw new Error(
          'Nuxt dev runtime options are missing the app root; the artifact was not produced by "neem dev"',
        )
      }
      const { root } = options

      shimWorkerUmask()

      // Before loadNuxt so config-load and builder output ride the bridge
      // from the first record.
      bridgeConsola(await importConsolaFrom(root), ctx.logger)

      const kit = await importKitFrom(root)
      const instance = await kit.loadNuxt({
        cwd: root,
        dev: true,
        ready: false,
        overrides: {
          telemetry: false,
          ...(options.base ? { app: { baseURL: options.base } } : {}),
        },
      })
      nuxt = instance

      // 503 with retry-after until buildNuxt swaps the real handler in, so
      // early proxy requests degrade gracefully instead of hanging.
      let handler: NodeHandler = (_req, res) => {
        res.statusCode = 503
        res.setHeader('retry-after', '2')
        res.end('Nuxt dev server is starting')
      }
      const httpServer = createServer((req, res) => handler(req, res))
      server = httpServer

      const port = await listenLoopback(httpServer)
      // The startup rejection above is settled; a late socket error must fail
      // the runtime instead of crashing the worker as an uncaught exception.
      httpServer.on('error', (error) => {
        if (!stopping) fail(error)
      })
      const url = `http://127.0.0.1:${port}`
      pinDevServerAddress(instance, port, url)

      await instance.ready()

      const base = normalizeBase(instance.options.app.baseURL || '/')
      assertRoutingBase(options.routing, base)
      sanitizeDevViteOptions(instance, ctx.logger)

      // Hard restarts (config/module changes) expect a process-level restart
      // — surface them as a runtime failure so the host restart policy
      // recycles the worker with a fresh artifact.
      instance.hook('restart', () => {
        if (!stopping) fail(new Error('Nuxt requested a dev server restart'))
      })

      // Sets nuxt._devServerListener in core, which Vite's HMR attaches to —
      // this is what puts the HMR WebSocket on the worker's port.
      await instance.hooks.callHook('listen', httpServer, { url })

      await kit.buildNuxt(instance)

      const built = await resolveDevHandler(instance, root)
      if (options.routing === 'path') {
        handler = (req, res) => {
          restoreBase(req, base)
          built(req, res)
        }
        // Vite's HMR upgrade handler checks the request path against the base
        // too, and it reads req.url before our 'upgrade' listener below —
        // prependListener keeps the restore ahead of it.
        httpServer.prependListener('upgrade', (req) => restoreBase(req, base))
      } else {
        handler = built
      }

      attachUpgradeRouting(httpServer, instance, base)

      ctx.logger.info(`Nuxt dev server listening at ${url}`)
      // Same port twice on purpose: HTTP and the HMR WebSocket share the
      // worker-owned server, and the Neem proxy tracks the transports
      // separately.
      return [
        { type: 'http', url },
        { type: 'ws', url },
      ]
    },
    async stop() {
      stopping = true
      const instance = nuxt
      nuxt = undefined
      const httpServer = server
      server = undefined
      // Nuxt first: closing watchers/vite before the listener avoids the
      // fsevents teardown assert observed on abrupt exits.
      await instance?.close().catch(() => {})
      await closeServer(httpServer)
    },
  }
}

// Handing Nuxt the worker-owned address before ready() prevents nitro from
// creating its own listener.
function pinDevServerAddress(
  nuxt: NuxtInstance,
  port: number,
  url: string,
): void {
  const { devServer } = nuxt.options
  devServer.host = '127.0.0.1'
  devServer.port = port
  devServer.url = url
  devServer.https = false
}

async function resolveDevHandler(
  nuxt: NuxtInstance,
  root: string,
): Promise<NodeHandler> {
  const server = nuxt.server
  if (server && typeof server.handler === 'function') {
    return server.handler
  }
  if (server?.app) {
    const h3 = await importH3From(root)
    return h3.toNodeListener(server.app)
  }
  if (server && typeof server.fetch === 'function') {
    throw new Error(
      'Nuxt dev server exposes a fetch-only shape (nitro v3); neem-nuxt currently supports nitropack v2 (handler/app) only',
    )
  }
  throw new Error('Nuxt dev server exposes none of handler/app/fetch')
}

/**
 * HMR upgrades ride Vite's own listener (attached via the listen hook);
 * everything else (e.g. app-level WebSocket routes) goes to nitro.
 */
function attachUpgradeRouting(
  server: Server,
  nuxt: NuxtInstance,
  base: string,
): void {
  const hmrPrefix = joinBasePath(base, nuxt.options.app.buildAssetsDir)
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '/').startsWith(hmrPrefix)) return
    if (nuxt.server?.upgrade) {
      nuxt.server.upgrade(req, socket, head)
    } else {
      socket.destroy()
    }
  })
}

/**
 * The `overrides` layer merges additively (defu), so proxy-bypassing HMR
 * endpoint options in the app's nuxt config could not be un-set through it —
 * mutate the resolved options after ready() instead, before the vite builder
 * reads them. The browser HMR client must derive its endpoint from the page
 * location so it rides the Neem proxy.
 */
function sanitizeDevViteOptions(
  nuxt: NuxtInstance,
  logger: NeemNuxtWorkerContext['logger'],
): void {
  const viteServer = nuxt.options.vite?.server
  if (!viteServer) return
  if (viteServer.https) {
    logger.warn(
      'nuxt config vite.server.https is dropped: TLS terminates at the Neem proxy and the dev server stays on plaintext loopback',
    )
    delete viteServer.https
  }
  const hmr = viteServer.hmr
  if (hmr && typeof hmr === 'object') {
    const overrides = [
      'host',
      'port',
      'clientPort',
      'server',
      'protocol',
    ] as const
    for (const key of overrides) {
      if (key in hmr) {
        logger.warn(
          `nuxt config vite.server.hmr.${key} would make the browser HMR client bypass the Neem proxy — option dropped`,
        )
        delete (hmr as Record<string, unknown>)[key]
      }
    }
  }
}

// consola's numeric level scale
const ERROR_LEVEL = 0
const WARN_LEVEL = 1
const DEBUG_LEVEL = 4

/**
 * Routes consola output (nuxt + nitro + the vite-builder's vite-log bridge)
 * through the Neem logger so dev logs are uniformly formatted and
 * runtime-tagged. Consola has no debug level below its numeric scale the way
 * pino does — mapping mirrors the vite preset: warnings/errors surface,
 * info-grade records are per-interaction chatter (hmr updates, build
 * timings) and go to debug; the lifecycle facts worth info are logged by the
 * preset itself.
 */
function bridgeConsola(
  consola: ConsolaLike | undefined,
  logger: NeemNuxtWorkerContext['logger'],
): void {
  if (!consola) return
  consola.setReporters([
    {
      log(logObj: ConsolaLogObject) {
        const message = formatConsolaArgs(logObj)
        if (logObj.level <= ERROR_LEVEL) logger.error(message)
        else if (logObj.level === WARN_LEVEL) logger.warn(message)
        else if (logObj.level >= DEBUG_LEVEL) logger.trace(message)
        else logger.debug(message)
      },
    },
  ])
}

function formatConsolaArgs(logObj: ConsolaLogObject): string {
  const text = logObj.args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack ?? arg.message
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
  return logObj.tag ? `[${logObj.tag}] ${text}` : text
}

function joinBasePath(base: string, path: string): string {
  const prefix = base === '/' ? '' : base.slice(0, -1)
  return prefix + (path.startsWith('/') ? path : `/${path}`)
}

export default createNuxtDevRuntime
