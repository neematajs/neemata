import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { NeemNuxtRoutingKind } from './types.ts'

/**
 * Minimal structural view of the Nuxt surface the preset touches. Kit is
 * resolved from the app's own installation at runtime, so importing real
 * `@nuxt/kit` types here would pin a nuxt version the artifact never bundles
 * and leak an unresolvable type dependency into consumers' d.ts resolution.
 */
export type NuxtInstance = {
  options: {
    app: { baseURL: string; buildAssetsDir: string }
    devServer: {
      host?: string
      port?: number
      url?: string
      https?: unknown
    }
    vite?: { server?: Record<string, unknown> }
  }
  ready: () => Promise<void>
  close: () => Promise<void>
  hooks: {
    callHook: (name: string, ...args: unknown[]) => Promise<unknown>
  }
  hook: (name: string, handler: (...args: never[]) => unknown) => unknown
  server?: NuxtDevServerLike
}

/**
 * nitropack v2 exposes an h3 `app`; nitro v3 moves to `fetch`. The preset
 * feature-detects like nuxt/cli does — `handler` first, then `app`.
 */
export type NuxtDevServerLike = {
  handler?: (req: IncomingMessage, res: ServerResponse) => void
  fetch?: (request: Request) => Promise<Response>
  app?: unknown
  upgrade?: (req: IncomingMessage, socket: unknown, head: Buffer) => void
}

export type NuxtKitModule = {
  loadNuxt: (options: {
    cwd: string
    dev?: boolean
    ready?: boolean
    overrides?: Record<string, unknown>
  }) => Promise<NuxtInstance>
  buildNuxt: (nuxt: NuxtInstance) => Promise<unknown>
  loadNuxtConfig: (options: {
    cwd: string
    overrides?: Record<string, unknown>
  }) => Promise<{ app?: { baseURL?: string; buildAssetsDir?: string } }>
}

/**
 * Resolves @nuxt/kit through the app's own nuxt installation: kit is nuxt's
 * dependency, not the app's, so under pnpm's strict layout it is invisible
 * from the app root — and resolving through nuxt keeps the kit/nuxt pair in
 * lockstep in monorepos with multiple nuxt versions.
 */
export async function importKitFrom(root: string): Promise<NuxtKitModule> {
  const nuxtRequire = createRequire(resolveNuxtPackage(root))
  const entry = nuxtRequire.resolve('@nuxt/kit')
  return (await import(pathToFileURL(entry).href)) as NuxtKitModule
}

type H3Module = {
  toNodeListener: (
    app: unknown,
  ) => (req: IncomingMessage, res: ServerResponse) => void
}

/**
 * Resolves h3 through nuxt's nitro distribution so `toNodeListener` comes
 * from the same h3 instance that built `nuxt.server.app` — a bare h3 import
 * could land on a different major with an incompatible app shape.
 */
export async function importH3From(root: string): Promise<H3Module> {
  const nuxtRequire = createRequire(resolveNuxtPackage(root))
  let nitroEntry: string | undefined
  // Nuxt 4 ships nitro as @nuxt/nitro-server; nuxt 3 depends on nitropack.
  for (const pkg of ['@nuxt/nitro-server', 'nitropack']) {
    try {
      nitroEntry = nuxtRequire.resolve(`${pkg}/package.json`)
      break
    } catch {}
  }
  if (!nitroEntry) {
    throw new Error(
      `Failed to resolve nitro (@nuxt/nitro-server or nitropack) from the nuxt installation at [${root}]`,
    )
  }
  const nitroRequire = createRequire(nitroEntry)
  const entry = nitroRequire.resolve('h3')
  return (await import(pathToFileURL(entry).href)) as H3Module
}

export type ConsolaLogObject = {
  level: number
  type: string
  tag?: string
  args: unknown[]
}

export type ConsolaLike = {
  setReporters: (
    reporters: Array<{ log: (logObj: ConsolaLogObject) => void }>,
  ) => unknown
}

/**
 * Resolves the app's consola instance (nuxt's own logging backbone — nuxt,
 * nitro, and the vite-builder's vite-log bridge all emit through it). Nuxt
 * offers no logger injection point the way vite's customLogger does, so
 * swapping consola's reporter is the one hook that catches everything.
 * Best-effort: a missing/unrecognized consola just leaves logs unbridged.
 */
export async function importConsolaFrom(
  root: string,
): Promise<ConsolaLike | undefined> {
  try {
    const nuxtRequire = createRequire(resolveNuxtPackage(root))
    // consola ships separate CJS and ESM builds with separate singleton
    // state; require.resolve lands on the CJS one, while nuxt (ESM) logs
    // through the MJS one — a reporter on the CJS instance would never see a
    // record. Walk the export conditions to the ESM entry explicitly. The
    // package root is found by walking up from the CJS entry, since consola
    // does not export ./package.json.
    const pkgPath = findPackageJson(nuxtRequire.resolve('consola'))
    if (!pkgPath) return undefined
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      exports?: Record<string, unknown>
    }
    const esmEntry = pickImportCondition(pkg.exports?.['.'])
    const entry = esmEntry
      ? join(dirname(pkgPath), esmEntry)
      : nuxtRequire.resolve('consola')
    const mod = (await import(pathToFileURL(entry).href)) as {
      consola?: ConsolaLike
      default?: ConsolaLike
    }
    const consola = mod.consola ?? mod.default
    return typeof consola?.setReporters === 'function' ? consola : undefined
  } catch {
    return undefined
  }
}

function findPackageJson(from: string): string | undefined {
  let dir = dirname(from)
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  return undefined
}

function pickImportCondition(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    for (const key of ['node', 'import', 'default']) {
      const picked = pickImportCondition(
        (entry as Record<string, unknown>)[key],
      )
      if (picked) return picked
    }
  }
  return undefined
}

function resolveNuxtPackage(root: string): string {
  const require = createRequire(join(root, 'package.json'))
  try {
    return require.resolve('nuxt/package.json')
  } catch (error) {
    throw new Error(
      `Failed to resolve [nuxt] from app root [${root}]; is nuxt installed for that app?`,
      { cause: error },
    )
  }
}

/**
 * @nuxt/vite-builder hardens its vite-node unix socket permissions via the
 * `process.umask(mask)` setter, which worker threads forbid
 * (ERR_WORKER_UNSUPPORTED_OPERATION). Reading stays supported — shim the
 * setter to a read-only no-op: the socket lives in the app's build dir and
 * is owned by the same user, so the restriction loses nothing here.
 */
export function shimWorkerUmask(): void {
  const readUmask = process.umask.bind(process)
  process.umask = ((_mask?: unknown) => readUmask()) as typeof process.umask
}

export function assertRoutingBase(
  routing: NeemNuxtRoutingKind | undefined,
  base: string,
): void {
  if (routing === 'path' && base === '/') {
    throw new Error(
      'Path-routed Neem proxy strips the "/<route>/" prefix upstream, so the Nuxt app must be ' +
        'configured with a matching app.baseURL: set [base] to the proxy route (e.g. "/admin/") ' +
        'or use default/subdomain routing',
    )
  }
}

// Nuxt also accepts relative and full-URL baseURLs, but neither can describe
// an app hosted behind the Neem proxy — reject instead of silently mangling
// them into broken absolute paths.
export function normalizeBase(base: string): string {
  if (base === '/') return '/'
  if (base === '' || base === './' || !base.startsWith('/')) {
    throw new Error(
      `neem-nuxt supports absolute path bases only (e.g. "/admin/"); received [${base}]`,
    )
  }
  return base.endsWith('/') ? base : `${base}/`
}

/**
 * A path-routed Neem proxy strips the `/<route>/` prefix before forwarding,
 * while Nuxt (with that prefix as app.baseURL) expects it present — nitro's
 * router and Vite's dev middleware both mount under the base. Restore it for
 * proxied requests; direct requests that already carry the base pass through.
 */
export function restoreBase(req: { url?: string }, base: string): void {
  const prefix = base.slice(0, -1)
  const url = req.url ?? '/'
  if (url !== prefix && !url.startsWith(base)) {
    req.url = prefix + url
  }
}
