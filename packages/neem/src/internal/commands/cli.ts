import * as module from 'node:module'
import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'

import type { NeemTestProbe } from '../test-probe.ts'
import { loadRuntimeSnapshot, runHostUntilClosed } from '../host/bootstrap.ts'
import { MANIFEST_FILE } from '../manifest/manifest.ts'
import { enableSourceMaps } from '../source-maps.ts'
import { createNeemTestProbe } from '../test-probe.ts'
import { serializeError } from '../utils.ts'
import {
  resolveDevOutDir,
  resolvePreviewOutDir,
  resolveStartOutDir,
} from './out-dir.ts'
import { runPreviewBuild } from './preview.ts'

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
export type PreviewCommandOptions = BuildCommandOptions & {
  'env-files'?: string
}

export async function runBuildCommand(
  args: BuildCommandOptions,
): Promise<void> {
  // Keep this command's compiler and native bindings out of production
  // daemons. Development owns its compiler through its watcher service.
  const { buildNeem } = await import('./build.ts')
  const probe = createNeemTestProbe()
  probe?.emit('cli:build:start')
  await buildNeem({
    config: args.config,
    outDir: args.outDir,
    runtimes: parseRuntimes(args.runtime),
  })
  probe?.emit('cli:build:closed')
}

export async function runStartCommand(
  args: StartCommandOptions,
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
    await serveBuiltOutput({
      outDir,
      runtimes: parseRuntimes(args.runtime),
      signal: controller.signal,
      probe,
    })
    probe?.emit('cli:start:closed')
  } finally {
    controller.dispose()
  }
}

/**
 * Builds production artifacts with source maps into a separate output, then
 * serves them exactly as `start` would. The build runs in a child process:
 * this process never loads the compiler, so serving does not carry the
 * memory a build retains.
 */
export async function runPreviewCommand(
  args: PreviewCommandOptions,
  signal?: AbortSignal,
): Promise<void> {
  // Loaded here, the files reach the build process and runtime workers alike.
  await loadCliEnvFiles(args['env-files'])
  const cwd = process.cwd()
  const configFile = resolve(cwd, args.config)
  const outDir = resolvePreviewOutDir({ cwd, configFile, outDir: args.outDir })
  const runtimes = parseRuntimes(args.runtime)
  const probe = createNeemTestProbe()
  const controller = createCliAbortController(signal)
  probe?.emit('cli:preview:start', { outDir })
  let restoreSourceMaps: (() => void) | undefined

  try {
    let buildPid: number | undefined
    const built = await runPreviewBuild(
      { config: configFile, outDir, runtimes },
      controller.signal,
      {
        onSpawn: (pid) => {
          buildPid = pid
          probe?.emit('cli:preview:build:start', { buildPid: pid })
        },
      },
    )
    probe?.emit('cli:preview:build:closed', { buildPid, built })
    if (!built) return
    // Mapped stacks are what a preview is for, whatever flags Node started
    // with; a programmatic caller gets its own setting back afterwards.
    restoreSourceMaps = enableSourceMaps()
    await serveBuiltOutput({
      outDir,
      runtimes,
      signal: controller.signal,
      probe,
    })
    probe?.emit('cli:preview:closed')
  } finally {
    restoreSourceMaps?.()
    controller.dispose()
  }
}

async function serveBuiltOutput(options: {
  outDir: string
  runtimes?: readonly string[]
  signal: AbortSignal
  probe: NeemTestProbe | undefined
}): Promise<void> {
  const { outDir, probe } = options
  const snapshot = await loadRuntimeSnapshot({
    mode: 'production',
    outDir,
    manifestFile: resolve(outDir, MANIFEST_FILE),
    runtimes: options.runtimes,
  })
  await runHostUntilClosed(snapshot, {
    signal: options.signal,
    onReady: (health) =>
      probe?.emit('runtime:ready', { type: 'ready', health }),
    onFailure: (error) =>
      probe?.emit('runtime:error', {
        type: 'error',
        error: serializeError(error),
      }),
    onStopped: () => probe?.emit('runtime:stopped', { type: 'stopped' }),
  })
}

export async function runDevCommand(
  args: DevCommandOptions,
  signal?: AbortSignal,
): Promise<void> {
  const { DevSession } = await import('../dev/session.ts')
  // Load before spawning services so config evaluation and runtime workers inherit the values.
  await loadCliEnvFiles(args['env-files'])
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

async function loadCliEnvFiles(value: string | undefined): Promise<void> {
  if (value === undefined) return
  const { loadEnvFiles } = await import('../env-files.ts')
  const paths = value.split(',').map((path) => path.trim())
  if (paths.some((path) => !path)) {
    throw new Error('--env-files requires non-empty file paths')
  }
  await Effect.runPromise(loadEnvFiles(paths))
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
