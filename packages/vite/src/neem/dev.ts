import type {
  Logger as ViteLogger,
  Plugin as VitePlugin,
  ResolvedConfig,
  ViteDevServer,
} from 'vite'
import { getRandomPort } from 'get-port-please'

import type { NeemViteRuntimeFactory, NeemViteWorkerContext } from '../types.ts'
import {
  assertRoutingBase,
  importViteFrom,
  loadAppViteConfig,
} from '../vite-loader.ts'

/**
 * Development implementation behind `neem-vite:impl`: boots Vite's own dev
 * server inside the runtime worker thread. Neem's watcher never sees the app
 * source — Vite owns that module graph, its watcher, and HMR.
 *
 * No `finished` wiring here on purpose: Vite restarts its own http server
 * (e.g. on .env changes), so listener close is not a death signal in dev.
 * The fixed `strictPort` port keeps the advertised upstream valid across
 * those self-restarts.
 */
const createViteDevRuntime: NeemViteRuntimeFactory = (ctx, options) => {
  let server: ViteDevServer | undefined

  return {
    async start() {
      const root = options.root
      if (!root) {
        throw new Error(
          'Vite dev runtime options are missing the app root; the artifact was not produced by "neem dev"',
        )
      }

      const vite = await importViteFrom(root)
      const loaded = await loadAppViteConfig(vite, {
        root,
        base: options.base,
        command: 'serve',
      })
      for (const warning of loaded.warnings) ctx.logger.warn(warning)
      assertRoutingBase(options.routing, loaded.base)

      // Route vite's server output through the Neem logger so dev logs are
      // uniformly formatted and runtime-tagged; an app-provided customLogger
      // is explicit user intent and wins.
      loaded.config.customLogger ??= createViteLoggerBridge(ctx.logger)

      // Vite treats port 0 as unset (falls back to 5173), and self-restarts
      // must rebind the same port so the upstream the proxy holds stays
      // valid — so the worker owns the allocation.
      const port = await getRandomPort('127.0.0.1')
      loaded.config.server = {
        ...loaded.config.server,
        port,
        strictPort: true,
      }
      if (options.routing === 'path') {
        loaded.config.plugins = [
          proxyBasePlugin(loaded.base),
          ...(loaded.config.plugins ?? []),
        ]
      }

      const instance = await vite.createServer(loaded.config)
      // The sanitizer normalized the file config, but a vite plugin's
      // config()/configResolved() hook runs later and could re-introduce
      // proxy-bypassing options — tripwire on the final resolved config.
      try {
        assertProxySafeResolvedConfig(instance.config, port)
      } catch (error) {
        await instance.close().catch(() => {})
        throw error
      }

      server = instance
      await instance.listen()

      const url = `http://127.0.0.1:${port}`
      ctx.logger.info(`Vite dev server listening at ${url}`)
      // Same port twice on purpose: Vite serves HTTP and the HMR WebSocket on
      // one server, and the Neem proxy tracks the transports separately.
      return [
        { type: 'http', url },
        { type: 'ws', url },
      ]
    },
    async stop() {
      const instance = server
      server = undefined
      await instance?.close()
    },
  }
}

/**
 * A path-routed Neem proxy strips the `/<route>/` prefix before forwarding,
 * while Vite (configured with that prefix as `base`) expects it — restore it
 * for proxied requests. Registered in configureServer so it runs ahead of
 * Vite's internal middleware stack. Direct (unproxied) requests that already
 * carry the base pass through untouched.
 */
function proxyBasePlugin(base: string): VitePlugin {
  const prefix = base.slice(0, -1)
  const restore = (req: { url?: string }) => {
    const url = req.url ?? '/'
    if (url !== prefix && !url.startsWith(base)) {
      req.url = prefix + url
    }
  }
  return {
    name: 'neem-vite:proxy-base',
    configureServer(devServer) {
      devServer.middlewares.use((req, _res, next) => {
        restore(req)
        next()
      })
      // Vite's HMR WebSocket upgrade handler checks the request path against
      // the base too, and connect middleware never sees upgrades — restore
      // the prefix on the raw request before Vite's listener reads it.
      devServer.httpServer?.prependListener('upgrade', (req) => {
        restore(req)
      })
    },
  }
}

function createViteLoggerBridge(
  logger: NeemViteWorkerContext['logger'],
): ViteLogger {
  const warnedOnce = new Set<string>()
  const loggedErrors = new WeakSet<object>()
  const bridge: ViteLogger = {
    hasWarned: false,
    // Vite's logger has no debug level and its info stream is per-interaction
    // chatter (hmr updates, reloads, re-optimizations); the lifecycle facts
    // worth info are logged by the preset itself.
    info(msg) {
      logger.debug(msg)
    },
    warn(msg) {
      bridge.hasWarned = true
      logger.warn(msg)
    },
    warnOnce(msg) {
      if (warnedOnce.has(msg)) return
      warnedOnce.add(msg)
      bridge.hasWarned = true
      logger.warn(msg)
    },
    error(msg, errorOptions) {
      const error = errorOptions?.error
      if (error) loggedErrors.add(error)
      if (error) logger.error({ err: error }, msg)
      else logger.error(msg)
    },
    clearScreen() {},
    hasErrorLogged(error) {
      return loggedErrors.has(error)
    },
  }
  return bridge
}

function assertProxySafeResolvedConfig(
  config: ResolvedConfig,
  port: number,
): void {
  if (config.server.middlewareMode) {
    throw new Error(
      'A vite plugin enabled server.middlewareMode, which is unsupported under Neem',
    )
  }
  if (config.server.https) {
    throw new Error(
      'A vite plugin enabled server.https; TLS terminates at the Neem proxy and the dev server must stay plaintext',
    )
  }
  if (config.server.host !== '127.0.0.1') {
    throw new Error(
      'A vite plugin changed server.host; the dev server must stay on loopback behind the Neem proxy',
    )
  }
  if (config.server.port !== port) {
    throw new Error(
      'A vite plugin changed server.port; the Neem-allocated port must be kept so the proxy upstream stays valid',
    )
  }
  const hmr = config.server.hmr
  if (typeof hmr === 'object' && hmr !== null) {
    const overrides = [
      'host',
      'port',
      'clientPort',
      'server',
      'protocol',
    ] as const
    for (const key of overrides) {
      if (hmr[key] !== undefined) {
        throw new Error(
          `A vite plugin set server.hmr.${key}, which would make the browser HMR client bypass the Neem proxy`,
        )
      }
    }
  }
}

export default createViteDevRuntime
