import type { Server } from 'node:http'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type {
  NeemNuxtProdOptions,
  NeemNuxtRuntimeFactory,
  NodeHandler,
} from '../types.ts'
import { restoreBase } from '../base.ts'
import { APP_DIR } from '../constants.ts'
import { closeServer, listenLoopback } from '../server.ts'
import { serveStaticFile, staticPath } from '../static.ts'

/**
 * Production implementation behind `neem-nuxt:impl`: hosts the nitro `node`
 * preset output that the artifact plugin wrote next to the worker bundle.
 * That preset exports a request listener and deliberately ships without
 * static serving, so the worker serves `public/` itself (hashed assets with
 * immutable caching) and falls through to the nitro listener for SSR. The
 * app directory is found relative to the bundle, so the artifact stays
 * relocatable and self-contained.
 */
const createNuxtProdRuntime: NeemNuxtRuntimeFactory<NeemNuxtProdOptions> = (
  ctx,
  options,
) => {
  const appDir = fileURLToPath(new URL(`./${APP_DIR}/`, import.meta.url))
  const publicDir = join(appDir, 'public')
  const { assetsDir, base } = options
  const pathRouted = options.routing === 'path'
  // A path-routed proxy already stripped the base prefix upstream, so the
  // static lookup has nothing left to strip.
  const staticBase = pathRouted ? '/' : base
  let server: Server | undefined
  let stopping = false
  const { promise: finished, reject: fail } = Promise.withResolvers<void>()
  void finished.catch(() => {})

  return {
    finished,
    async start() {
      const entryPath = join(appDir, 'server/index.mjs')
      if (!existsSync(entryPath)) {
        throw new Error(
          `Nuxt app build not found at [${entryPath}]; the artifact was not produced by "neem build"`,
        )
      }
      const entry = (await import(pathToFileURL(entryPath).href)) as {
        listener?: NodeHandler
        handler?: NodeHandler
      }
      const listener = entry.listener ?? entry.handler
      if (typeof listener !== 'function') {
        throw new Error(
          'Nitro server entry exports no listener/handler; neem-nuxt currently supports the nitropack v2 "node" preset only',
        )
      }

      const instance = createServer((req, res) => {
        // Static lookup works on the base-stripped path (nitro writes public/
        // without the prefix); the nitro handler needs the prefix PRESENT
        // (its router mounts under app.baseURL), so restore what a
        // path-routed proxy stripped before falling through.
        const stripped = staticPath(req, staticBase)
        if (
          stripped &&
          serveStaticFile(req, res, publicDir, stripped, assetsDir)
        ) {
          return
        }
        if (pathRouted) restoreBase(req, base)
        listener(req, res)
      })
      server = instance

      // App-level WebSocket routes need nitro's experimental crossws hooks
      // wired through the entry's `websocket` export — not covered yet;
      // refuse upgrades instead of leaving sockets hanging.
      instance.on('upgrade', (_req, socket) => socket.destroy())

      const port = await listenLoopback(instance)
      // The startup rejection above is settled; a late socket error must fail
      // the runtime instead of crashing the worker as an uncaught exception.
      instance.on('error', (error) => {
        if (!stopping) fail(error)
      })
      const url = `http://127.0.0.1:${port}`
      instance.once('close', () => {
        if (!stopping) fail(new Error('Nuxt app server closed unexpectedly'))
      })

      ctx.logger.info(`Nuxt app server listening at ${url} (base ${base})`)
      return [{ type: 'http', url }]
    },
    async stop() {
      stopping = true
      const instance = server
      server = undefined
      await closeServer(instance)
    },
  }
}

export default createNuxtProdRuntime
