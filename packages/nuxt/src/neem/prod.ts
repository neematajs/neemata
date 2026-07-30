import type { Stats } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { NeemNuxtRuntimeFactory } from '../types.ts'
import { APP_DIR } from '../constants.ts'
import { restoreBase } from '../nuxt-loader.ts'

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void

/**
 * Production implementation behind `neem-nuxt:impl`: hosts the nitro `node`
 * preset output that the artifact plugin wrote next to the worker bundle.
 * That preset exports a request listener and deliberately ships without
 * static serving, so the worker serves `public/` itself (hashed assets with
 * immutable caching) and falls through to the nitro listener for SSR. The
 * app directory is found relative to the bundle, so the artifact stays
 * relocatable and self-contained.
 */
const createNuxtProdRuntime: NeemNuxtRuntimeFactory = (ctx, options) => {
  const appDir = fileURLToPath(new URL(`./${APP_DIR}/`, import.meta.url))
  const publicDir = join(appDir, 'public')
  const base = options.base ?? '/'
  const assetsDir = options.assetsDir ?? '/_nuxt/'
  let server: Server | undefined
  let stopping = false
  let failListener: (error: Error) => void = () => {}
  const finished = new Promise<void>((_resolve, reject) => {
    failListener = reject
  })
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
          'Nitro server entry exports no listener/handler; the neem-nuxt prototype supports the nitropack v2 "node" preset only',
        )
      }

      const instance = createServer((req, res) => {
        // Static lookup works on the base-stripped path (nitro writes public/
        // without the prefix); the nitro handler needs the prefix PRESENT
        // (its router mounts under app.baseURL), so restore what a
        // path-routed proxy stripped before falling through.
        const stripped = staticPath(req, base, options.routing === 'path')
        if (stripped && serveStaticFile(req, res, publicDir, stripped, assetsDir)) {
          return
        }
        if (options.routing === 'path') restoreBase(req, base)
        listener(req, res)
      })
      server = instance

      // App-level WebSocket routes need nitro's experimental crossws hooks
      // wired through the entry's `websocket` export — not covered by the
      // prototype; refuse upgrades instead of leaving sockets hanging.
      instance.on('upgrade', (_req, socket) => socket.destroy())

      await new Promise<void>((resolve, reject) => {
        instance.once('error', reject)
        instance.listen(0, '127.0.0.1', resolve)
      })
      const address = instance.address()
      if (!address || typeof address === 'string') {
        throw new Error('Nuxt app server did not report a tcp address')
      }
      const url = `http://127.0.0.1:${address.port}`
      instance.once('close', () => {
        if (!stopping) {
          failListener(new Error('Nuxt app server closed unexpectedly'))
        }
      })

      ctx.logger.info(`Nuxt app server listening at ${url} (base ${base})`)
      return [{ type: 'http', url }]
    },
    async stop() {
      stopping = true
      const instance = server
      server = undefined
      await new Promise<void>((resolve) => {
        if (!instance) return resolve()
        instance.close(() => resolve())
        // The Neem proxy holds keep-alive upstream connections; a graceful
        // close would wait on those idle sockets indefinitely.
        instance.closeAllConnections()
      })
    },
  }
}

/**
 * Resolves the on-disk lookup path for a request, or undefined when the
 * request cannot be a static file (non-GET/HEAD, or outside the base). With
 * path routing the proxy already stripped the base; otherwise strip it here
 * to match the prefix-less public/ layout.
 */
function staticPath(
  req: IncomingMessage,
  base: string,
  proxyStripped: boolean,
): string | undefined {
  if (req.method !== 'GET' && req.method !== 'HEAD') return undefined
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://n').pathname)
  } catch {
    return undefined
  }
  if (proxyStripped || base === '/') return pathname
  const prefix = base.slice(0, -1)
  if (pathname === prefix) return '/'
  if (pathname.startsWith(base)) return pathname.slice(prefix.length)
  return undefined
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
}

function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  publicDir: string,
  pathname: string,
  assetsDir: string,
): boolean {
  const normalized = normalize(pathname)
  if (normalized.includes('..')) return false
  // Prerendered pages (routeRules prerender) are emitted as
  // `<route>/index.html` and removed from the server routes — nitro relies
  // on the static layer for them, so directory hits resolve to their index.
  const file = resolveFile(join(publicDir, normalized))
  if (!file) return false

  const type = MIME[extname(file.path)]
  res.writeHead(200, {
    ...(type ? { 'content-type': type } : {}),
    'content-length': file.stats.size,
    // Hashed build assets are immutable by nitro's output contract;
    // everything else must revalidate.
    'cache-control': pathname.startsWith(assetsDir)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(file.path).pipe(res)
  return true
}

function resolveFile(
  path: string,
): { path: string; stats: Stats } | undefined {
  let stats: Stats
  try {
    stats = statSync(path)
  } catch {
    return undefined
  }
  if (stats.isFile()) return { path, stats }
  if (!stats.isDirectory()) return undefined
  const index = join(path, 'index.html')
  try {
    const indexStats = statSync(index)
    if (indexStats.isFile()) return { path: index, stats: indexStats }
  } catch {}
  return undefined
}

export default createNuxtProdRuntime
