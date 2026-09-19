import type { Stats } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream'

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

/**
 * Resolves the on-disk lookup path for a request, or undefined when the
 * request cannot be a static file (non-GET/HEAD, or outside the base). Nitro
 * writes public/ without the base prefix, so whatever prefix the request
 * still carries is stripped here — a path-routed proxy already stripped it
 * upstream and therefore passes '/'.
 */
export function staticPath(
  req: IncomingMessage,
  base: string,
): string | undefined {
  if (req.method !== 'GET' && req.method !== 'HEAD') return undefined
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://n').pathname)
  } catch {
    return undefined
  }
  if (base === '/') return pathname
  const prefix = base.slice(0, -1)
  if (pathname === prefix) return '/'
  if (pathname.startsWith(base)) return pathname.slice(prefix.length)
  return undefined
}

export function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  publicDir: string,
  pathname: string,
  assetsDir: string,
): boolean {
  // Containment on the resolved path covers `..` in any encoding and any
  // separator style, unlike a substring check on the raw pathname.
  const target = resolve(publicDir, pathname.slice(1))
  if (target !== publicDir && !target.startsWith(publicDir + sep)) return false
  // Prerendered pages (routeRules prerender) are emitted as
  // `<route>/index.html` and removed from the server routes — nitro relies
  // on the static layer for them, so directory hits resolve to their index.
  const file = resolveFile(target)
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
  // pipeline destroys both sides on failure: a client abort must not leak
  // the file descriptor and an open/read race must not become an uncaught
  // exception in the worker — either way the response is already doomed.
  pipeline(createReadStream(file.path), res, () => {})
  return true
}

function resolveFile(path: string): { path: string; stats: Stats } | undefined {
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
