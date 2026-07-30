import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type * as Vite from 'vite'

export type ViteModule = typeof Vite

/**
 * Resolves vite from the app root instead of this module's own location: the
 * dev artifact lives under the Neem outDir (possibly a different package in a
 * monorepo), so a bare `import 'vite'` would miss the app's installation.
 */
export async function importViteFrom(root: string): Promise<ViteModule> {
  const require = createRequire(join(root, 'package.json'))
  let entry: string
  try {
    entry = require.resolve('vite')
  } catch (error) {
    throw new Error(
      `Failed to resolve [vite] from app root [${root}]; is vite installed for that app?`,
      { cause: error },
    )
  }
  return (await import(pathToFileURL(entry).href)) as ViteModule
}

export type LoadedAppViteConfig = {
  config: Vite.InlineConfig
  /** Effective public base: preset option > app config > '/'. */
  base: string
  /** Sanitizer notes about dropped/overridden user options. */
  warnings: readonly string[]
  /** Files the app config was loaded from (config + its imports). */
  dependencies: readonly string[]
}

export type LoadAppViteConfigOptions = {
  root: string
  base?: string
  command: 'serve' | 'build'
}

/**
 * Loads the app's vite config and re-applies it under the preset's control
 * instead of handing the file to vite directly. Vite's config merge is
 * additive, so topology options the proxy contract depends on (listener,
 * HMR endpoint) could not be un-set through inline overrides — owning the
 * merge lets the preset normalize them while keeping everything else the
 * user wrote. The returned config carries `configFile: false`.
 */
export async function loadAppViteConfig(
  vite: ViteModule,
  options: LoadAppViteConfigOptions,
): Promise<LoadedAppViteConfig> {
  const mode = options.command === 'serve' ? 'development' : 'production'
  const loaded = await vite.loadConfigFromFile(
    { command: options.command, mode },
    undefined,
    options.root,
  )
  const user = loaded?.config ?? {}
  const warnings: string[] = []
  const base = normalizeBase(options.base ?? user.base ?? '/')

  const config: Vite.InlineConfig = {
    ...user,
    configFile: false,
    root: options.root,
    base,
    clearScreen: false,
    ...(options.command === 'serve'
      ? { server: sanitizeServer(user.server, warnings) }
      : { build: sanitizeBuild(user.build, warnings) }),
  }

  return {
    config,
    base,
    warnings,
    dependencies: loaded?.dependencies ?? [],
  }
}

function sanitizeServer(
  server: Vite.ServerOptions | undefined,
  warnings: string[],
): Vite.ServerOptions {
  const {
    host,
    port,
    strictPort: _strictPort,
    origin,
    middlewareMode,
    https,
    hmr,
    ...rest
  } = server ?? {}

  if (middlewareMode) {
    warnings.push(
      'vite config server.middlewareMode is not supported under Neem; the runtime worker owns the listener — option dropped',
    )
  }
  if (https) {
    warnings.push(
      'vite config server.https is dropped: TLS terminates at the Neem proxy and the dev app server stays on plaintext loopback',
    )
  }
  if (host !== undefined || port !== undefined || origin !== undefined) {
    warnings.push(
      'vite config server.host/port/origin are managed by Neem (loopback, ephemeral port behind the proxy) — options dropped',
    )
  }

  return {
    ...rest,
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    hmr: sanitizeHmr(hmr, warnings),
  }
}

// The browser HMR client must derive its endpoint from the page location so
// it rides the proxy; any explicit endpoint override would bypass it.
function sanitizeHmr(
  hmr: Vite.ServerOptions['hmr'],
  warnings: string[],
): Vite.ServerOptions['hmr'] {
  if (hmr === undefined || hmr === false) return hmr
  const options = hmr === true ? {} : hmr
  const { host, port, clientPort, server, protocol, ...rest } = options
  if (
    host !== undefined ||
    port !== undefined ||
    clientPort !== undefined ||
    server !== undefined ||
    protocol !== undefined
  ) {
    warnings.push(
      'vite config server.hmr endpoint overrides (host/port/clientPort/server/protocol) would bypass the Neem proxy — options dropped',
    )
  }
  return rest
}

function sanitizeBuild(
  build: Vite.BuildEnvironmentOptions | undefined,
  warnings: string[],
): Vite.BuildEnvironmentOptions {
  const { write, outDir, emptyOutDir, watch, rollupOptions, ...rest } =
    build ?? {}
  if (write === false) {
    warnings.push(
      'vite config build.write=false is dropped: Neem serves the built app from the artifact directory',
    )
  }
  if (outDir !== undefined || emptyOutDir !== undefined) {
    warnings.push(
      'vite config build.outDir/emptyOutDir are managed by Neem (the app is built into the worker artifact) — options dropped',
    )
  }
  if (watch !== undefined && watch !== null) {
    warnings.push(
      'vite config build.watch is dropped: the app build runs once inside "neem build"',
    )
  }
  return {
    ...rest,
    ...(rollupOptions
      ? { rollupOptions: sanitizeRollupOptions(rollupOptions, warnings) }
      : {}),
  }
}

// Nested output targets would redirect the build outside the artifact even
// with build.outDir forced, so they get the same treatment.
function sanitizeRollupOptions(
  rollupOptions: NonNullable<Vite.BuildEnvironmentOptions['rollupOptions']>,
  warnings: string[],
): Vite.BuildEnvironmentOptions['rollupOptions'] {
  const output = rollupOptions.output
  if (!output) return rollupOptions

  let stripped = false
  const sanitizeOutput = <T extends { dir?: unknown; file?: unknown }>(
    entry: T,
  ): T => {
    if (entry.dir === undefined && entry.file === undefined) return entry
    stripped = true
    const { dir: _dir, file: _file, ...restOutput } = entry
    return restOutput as T
  }
  const sanitized = Array.isArray(output)
    ? output.map(sanitizeOutput)
    : sanitizeOutput(output)
  if (stripped) {
    warnings.push(
      'vite config build.rollupOptions.output.dir/file are managed by Neem (the app is built into the worker artifact) — options dropped',
    )
  }
  return { ...rollupOptions, output: sanitized }
}

export function assertRoutingBase(
  routing: 'path' | 'subdomain' | 'default' | undefined,
  base: string,
): void {
  if (routing === 'path' && base === '/') {
    throw new Error(
      'Path-routed Neem proxy strips the "/<route>/" prefix upstream, so the Vite app must be built ' +
        'with a matching base: set base to the proxy route (e.g. "/web/") or use default/subdomain routing',
    )
  }
}

// Vite also accepts relative ('', './') and full-URL bases, but neither can
// describe an app hosted behind the Neem proxy — reject instead of silently
// mangling them into broken absolute paths.
export function normalizeBase(base: string): string {
  if (base === '/') return '/'
  if (base === '' || base === './' || !base.startsWith('/')) {
    throw new Error(
      `neem-vite supports absolute path bases only (e.g. "/app/"); received [${base}]`,
    )
  }
  return base.endsWith('/') ? base : `${base}/`
}
