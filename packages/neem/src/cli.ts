import * as module from 'node:module'
import { resolve } from 'node:path'

import { config as loadDotenv } from '@dotenvx/dotenvx'
import { defineCommand } from 'citty'

import { buildNeem } from './internal/commands/build.ts'
import { runDev } from './internal/commands/dev.ts'
import { startNeem } from './internal/commands/start.ts'
import {
  DEFAULT_CONFIG_FILE,
  DEFAULT_DEV_OUT_DIR,
  DEFAULT_OUT_DIR,
} from './internal/layout.ts'
import { parseRuntimeNames } from './internal/runtime-selection.ts'
import { createNeemTestProbe } from './internal/test-probe.ts'

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
      default: DEFAULT_CONFIG_FILE,
    },
    outDir: {
      type: 'string',
      description: 'Output directory. Overrides config outDir.',
    },
  },
  async run({ args }) {
    const probe = createNeemTestProbe()
    probe?.emit('cli:build:start')
    await buildNeem({
      config: args.config,
      outDir: args.outDir,
      runtimes: parseRuntimeNames(args.runtime),
    })
    probe?.emit('cli:build:closed')
  },
})

export const startCommand = defineCommand({
  meta: { name: 'start', description: 'Start a built Neem runtime server.' },
  args: {
    outDir: {
      type: 'string',
      description: 'Built output directory.',
      default: DEFAULT_OUT_DIR,
    },
    runtime: {
      type: 'positional',
      description: 'Comma-separated runtime names to start.',
      required: false,
    },
  },
  async run({ args }) {
    await startNeem({
      outDir: resolve(process.cwd(), args.outDir),
      runtimes: parseRuntimeNames(args.runtime),
    })
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
      default: DEFAULT_CONFIG_FILE,
    },
    outDir: {
      type: 'string',
      description: 'Development output directory.',
      default: DEFAULT_DEV_OUT_DIR,
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
    envFiles: {
      type: 'string',
      description:
        'Comma-separated env files relative to cwd. Existing variables and earlier files take precedence.',
    },
    cacheDir: {
      type: 'string',
      description: 'Directory for Node.js compile cache',
    },
  },
  async run({ args }) {
    loadEnvFiles(args.envFiles)
    if (args.cache) enableCompileCache(args.cacheDir)

    await runDev({
      configFile: resolve(process.cwd(), args.config),
      outDir: resolve(process.cwd(), args.outDir),
      runtimes: parseRuntimeNames(args.runtime),
    })
  },
})

export const mainCommand = defineCommand({
  meta: { name: 'neem', description: 'Neem host CLI.' },
  subCommands: { build: buildCommand, dev: devCommand, start: startCommand },
})

function loadEnvFiles(files: string | undefined): void {
  if (files === undefined) return
  const paths = files.split(',').map((path) => path.trim())
  if (paths.some((path) => !path)) {
    throw new Error('--env-files requires non-empty file paths')
  }
  // Load before spawning services so config evaluation and runtime workers inherit the values.
  loadDotenv({ path: paths, quiet: true, strict: true })
}

function enableCompileCache(directory: string | undefined): void {
  const result = module.enableCompileCache({ directory })
  if (result.status !== module.constants.compileCacheStatus.ENABLED) return
  if (result.directory === undefined) return

  process.env.NODE_COMPILE_CACHE = result.directory
  process.stderr.write(`Node.js compile cache enabled at ${result.directory}\n`)
}
