import * as module from 'node:module'
import { resolve } from 'node:path'

// dotenvx is CommonJS; since 2.30.0 Node no longer detects its named exports.
import dotenvx from '@dotenvx/dotenvx'
import { defineCommand } from 'citty'

import { buildNeem } from './internal/commands/build.ts'
import {
  resolveDevOutDir,
  resolveStartOutDir,
} from './internal/commands/out-dir.ts'
import { DevSession } from './internal/dev/session.ts'
import {
  loadRuntimeSnapshot,
  runHostUntilClosed,
} from './internal/host/bootstrap.ts'
import { MANIFEST_FILE } from './internal/manifest/manifest.ts'
import { createNeemTestProbe } from './internal/test-probe.ts'
import { serializeError } from './internal/utils.ts'

export const buildCommand = defineCommand({
  meta: {
    name: 'build',
    description: 'Build Neem config and runtime artifacts.',
  },
  args: {
    runtime: {
      type: 'positional',
      description: 'Comma-separated runtime names to build.',
      required: false,
    },
    config: {
      type: 'string',
      description: 'Path to neem.config file.',
      default: 'neem.config.ts',
    },
    outDir: {
      type: 'string',
      description:
        'Output directory relative to cwd. Overrides config outDir, which resolves from the config file (default: dist).',
    },
  },
  async run({ args }) {
    const probe = createNeemTestProbe()
    probe?.emit('cli:build:start')
    await buildNeem({
      config: args.config,
      outDir: args.outDir,
      runtimes: parseRuntimes(args.runtime),
    })
    probe?.emit('cli:build:closed')
  },
})

export const startCommand = defineCommand({
  meta: { name: 'start', description: 'Start a built Neem runtime server.' },
  args: {
    config: {
      type: 'string',
      description:
        'Path to neem.config file. Starts its outDir; evaluates the config.',
    },
    outDir: {
      type: 'string',
      description:
        'Built output directory relative to cwd. Overrides --config (default: dist).',
    },
    runtime: {
      type: 'positional',
      description: 'Comma-separated runtime names to start.',
      required: false,
    },
  },
  async run({ args }) {
    const outDir = await resolveStartOutDir({
      cwd: process.cwd(),
      config: args.config,
      outDir: args.outDir,
    })
    const probe = createNeemTestProbe()
    const controller = createCliAbortController()
    probe?.emit('cli:start:start')

    try {
      const snapshot = await loadRuntimeSnapshot({
        mode: 'production',
        outDir,
        manifestFile: resolve(outDir, MANIFEST_FILE),
        runtimes: parseRuntimes(args.runtime),
      })
      await runHostUntilClosed(snapshot, {
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
  },
})

export const devCommand = defineCommand({
  meta: {
    name: 'dev',
    description: 'Start a watched Neem development server.',
  },
  args: {
    config: {
      type: 'string',
      description: 'Path to neem.config file.',
      default: 'neem.config.ts',
    },
    outDir: {
      type: 'string',
      description:
        'Development output directory relative to cwd (default: .neem/<config name> next to the config).',
    },
    runtime: {
      type: 'positional',
      description: 'Comma-separated runtime names to start in dev.',
      required: false,
    },
    cache: {
      type: 'boolean',
      description: 'Enable Node.js compile cache',
      default: true,
    },
    cacheDir: {
      type: 'string',
      description: 'Directory for Node.js compile cache',
    },
    'env-files': {
      type: 'string',
      description:
        'Comma-separated env files relative to cwd. Existing variables and earlier files take precedence.',
    },
  },
  async run({ args }) {
    if (args['env-files'] !== undefined) {
      const paths = args['env-files'].split(',').map((path) => path.trim())
      if (paths.some((path) => !path)) {
        throw new Error('--env-files requires non-empty file paths')
      }
      // Load before spawning services so config evaluation and runtime workers inherit the values.
      dotenvx.config({ path: paths, quiet: true, strict: true })
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
    const controller = createCliAbortController()
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
  },
})

export const mainCommand = defineCommand({
  meta: { name: 'neem', description: 'Neem host CLI.' },
  subCommands: { build: buildCommand, dev: devCommand, start: startCommand },
})

function parseRuntimes(runtime?: string): string[] | undefined {
  if (!runtime) return undefined
  const runtimes = runtime
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  return runtimes.length > 0 ? [...new Set(runtimes)] : undefined
}

function createCliAbortController() {
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
