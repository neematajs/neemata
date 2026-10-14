import * as module from 'node:module'
import { resolve } from 'node:path'

// dotenvx is CommonJS; since 2.30.0 Node no longer detects its named exports.
import dotenvx from '@dotenvx/dotenvx'

import type { NeemHostFlavor } from '../flavor.ts'
import { DevSession } from '../dev/session.ts'
import { buildFlavor } from '../flavor.ts'
import { loadRuntimeSnapshot, runHostUntilClosed } from '../host/bootstrap.ts'
import { MANIFEST_FILE } from '../manifest/manifest.ts'
import { createNeemTestProbe } from '../test-probe.ts'
import { serializeError } from '../utils.ts'
import { buildNeem } from './build.ts'
import { resolveDevOutDir, resolveStartOutDir } from './out-dir.ts'

export type BuildCommandOptions = {
  config: string
  outDir?: string
  runtime?: string
}
export type StartCommandOptions = {
  config?: string
  outDir?: string
  runtime?: string
}
export type DevCommandOptions = BuildCommandOptions & {
  cache: boolean
  cacheDir?: string
  'env-files'?: string
}

export async function runBuildCommand(
  args: BuildCommandOptions,
  flavor?: NeemHostFlavor,
): Promise<void> {
  const probe = createNeemTestProbe()
  probe?.emit('cli:build:start')
  await buildNeem({
    flavor: buildFlavor(flavor),
    config: args.config,
    outDir: args.outDir,
    runtimes: parseRuntimes(args.runtime),
  })
  probe?.emit('cli:build:closed')
}

export async function runStartCommand(
  args: StartCommandOptions,
  flavor?: NeemHostFlavor,
  signal?: AbortSignal,
): Promise<void> {
  const outDir = await resolveStartOutDir({
    cwd: process.cwd(),
    config: args.config,
    outDir: args.outDir,
  })
  const probe = createNeemTestProbe()
  const controller = createCliAbortController(signal)
  probe?.emit('cli:start:start')

  try {
    const snapshot = await (flavor?.loadSnapshot ?? loadRuntimeSnapshot)({
      mode: 'production',
      flavor: flavor?.name,
      outDir,
      manifestFile: resolve(outDir, MANIFEST_FILE),
      runtimes: parseRuntimes(args.runtime),
    })
    await (flavor?.runHostUntilClosed ?? runHostUntilClosed)(snapshot, {
      signal: controller.signal,
      onReady: (health) =>
        probe?.emit('runtime:ready', { type: 'ready', health }),
      onFailure: (error) =>
        probe?.emit('runtime:error', {
          type: 'error',
          error: serializeError(error),
        }),
      onStopped: () => probe?.emit('runtime:stopped', { type: 'stopped' }),
    })
    probe?.emit('cli:start:closed')
  } finally {
    controller.dispose()
  }
}

export async function runDevCommand(
  args: DevCommandOptions,
  flavor?: NeemHostFlavor,
  signal?: AbortSignal,
): Promise<void> {
  if (args['env-files'] !== undefined) {
    const paths = args['env-files'].split(',').map((path) => path.trim())
    if (paths.some((path) => !path)) {
      throw new Error('--env-files requires non-empty file paths')
    }
    // Load before spawning services so config evaluation and runtime workers inherit the values.
    if (flavor?.loadEnvFiles) await flavor.loadEnvFiles(paths)
    else loadLegacyEnvFiles(paths)
  }
  if (args.cache && 'enableCompileCache' in module) {
    const result = module.enableCompileCache({ directory: args.cacheDir })
    if (result && typeof result === 'object') {
      const { status, directory } = result
      if (status === module.constants.compileCacheStatus.ENABLED) {
        process.env.NODE_COMPILE_CACHE = directory
        console.log(`Node.js compile cache enabled at ${directory}`)
      }
    }
  }
  const cwd = process.cwd()
  const configFile = resolve(cwd, args.config)
  const controller = createCliAbortController(signal)
  const session = new DevSession({
    flavor,
    configFile,
    outDir: resolveDevOutDir({ cwd, configFile, outDir: args.outDir }),
    runtimes: parseRuntimes(args.runtime),
    signal: controller.signal,
    probe: createNeemTestProbe(),
  })

  let failed = false
  try {
    await session.start()
    await session.closed
  } catch (error) {
    failed = true
    throw error
  } finally {
    controller.dispose()
    // The first error wins: a stop failure already rejected `closed`, and
    // after another failure it must not replace that one.
    if (failed) await session.stop().catch(() => undefined)
    else await session.stop()
  }
}

function parseRuntimes(runtime?: string): string[] | undefined {
  if (!runtime) return undefined
  const runtimes = runtime
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  return runtimes.length > 0 ? [...new Set(runtimes)] : undefined
}

function createCliAbortController(signal?: AbortSignal) {
  if (signal) return { signal, dispose() {} }
  const controller = new AbortController()
  const abort = () => controller.abort()

  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)

  return {
    signal: controller.signal,
    dispose() {
      process.off('SIGINT', abort)
      process.off('SIGTERM', abort)
    },
  }
}

export function loadLegacyEnvFiles(paths: readonly string[]): void {
  dotenvx.config({ path: [...paths], quiet: true, strict: true })
}
