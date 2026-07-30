import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Server, ServerMiddleware } from 'srvx'
// Explicit Node adapter per srvx's bundler guidance: neem bundles this module
// with rolldown, and the artifact only ever runs in Node worker threads, so
// resolving the runtime at bundle time is correct — importing srvx/node just
// stops depending on the bundler's condition setup to pick it.
import { FastResponse, serve } from 'srvx/node'
import { serveStatic } from 'srvx/static'

import type { NeemViteRuntimeFactory } from '../types.ts'
import { APP_DIR } from '../constants.ts'

/**
 * Production implementation behind `neem-vite:impl`: serves the `vite build`
 * output that the artifact plugin wrote next to the worker bundle via srvx.
 * The app directory is found relative to the bundle itself and srvx is
 * bundled in, so the artifact stays relocatable and self-contained.
 */
const createViteProdRuntime: NeemViteRuntimeFactory = (ctx, options) => {
  const appDir = fileURLToPath(new URL(`./${APP_DIR}/`, import.meta.url))
  const base = options.base ?? '/'
  // A path-routed proxy already strips the base prefix upstream; any other
  // routing forwards it verbatim, so the static layer must strip it to match
  // the on-disk layout (vite build writes to the outDir root regardless of
  // base).
  const stripPrefix =
    options.routing !== 'path' && base !== '/' ? base.slice(0, -1) : undefined
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
      const shell = await readShell(resolve(appDir, 'index.html'))

      const instance = serve({
        hostname: '127.0.0.1',
        port: 0,
        silent: true,
        middleware: [
          withStaticPolicy(serveStatic({ dir: appDir }), stripPrefix),
        ],
        fetch: (request) => spaFallback(request, shell),
        error: (error) => {
          ctx.logger.error({ err: error }, 'Vite app request failed')
          return new FastResponse(null, { status: 500 })
        },
      })
      server = instance
      await instance.ready()

      const url = instance.url
      if (!url) {
        throw new Error('Vite app server did not report a listening URL')
      }
      instance.node?.server?.once('close', () => {
        if (!stopping) {
          failListener(new Error('Vite app server closed unexpectedly'))
        }
      })

      ctx.logger.info(`Vite app server listening at ${url} (base ${base})`)
      return [{ type: 'http', url }]
    },
    async stop() {
      stopping = true
      const instance = server
      server = undefined
      // The Neem proxy holds keep-alive upstream connections; a default
      // graceful close would wait on those idle sockets indefinitely.
      await instance?.close(true)
    },
  }
}

async function readShell(path: string): Promise<Uint8Array> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Vite app build not found at [${path}]; the artifact was not produced by "neem build"`,
      )
    }
    throw new Error(`Failed to read Vite app shell at [${path}]`, {
      cause: error,
    })
  }
}

/**
 * serveStatic emits no caching headers and its MIME table misses .wasm;
 * hashed /assets/ files are immutable by Vite's output contract, everything
 * else must revalidate. With `stripPrefix` set, the base prefix is removed
 * from the request before the static layer sees it, so lookups and the
 * policy both work on the on-disk layout.
 */
function withStaticPolicy(
  inner: ServerMiddleware,
  stripPrefix: string | undefined,
): ServerMiddleware {
  return async (request, next) => {
    let pathname = new URL(request.url).pathname
    if (
      stripPrefix &&
      (pathname === stripPrefix || pathname.startsWith(`${stripPrefix}/`))
    ) {
      const url = new URL(request.url)
      pathname = pathname.slice(stripPrefix.length) || '/'
      url.pathname = pathname
      // ServerRequest#_url is srvx's documented parsed-URL slot and
      // serveStatic reads it before falling back to request.url — setting it
      // strips the prefix without reconstructing a Request from the proxy.
      request._url = url
    }

    const response = await inner(request, next)
    if (response.ok) {
      if (pathname.endsWith('.wasm')) {
        response.headers.set('content-type', 'application/wasm')
      }
      if (!response.headers.has('cache-control')) {
        response.headers.set(
          'cache-control',
          pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        )
      }
    }
    return response
  }
}

// History-API fallback for everything serveStatic missed: navigations (the
// request explicitly accepts text/html) render the SPA shell — including
// routes like /users/jane.doe — while script/fetch/asset misses are genuine
// 404s.
function spaFallback(request: Request, shell: Uint8Array): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new FastResponse(null, {
      status: 405,
      headers: { allow: 'GET, HEAD' },
    })
  }
  const accept = request.headers.get('accept') ?? ''
  if (!accept.includes('text/html')) {
    return new FastResponse('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  return new FastResponse(shell, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    },
  })
}

export default createViteProdRuntime
