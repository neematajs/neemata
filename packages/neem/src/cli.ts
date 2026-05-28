import type { ChildProcess } from 'node:child_process'
import { fork } from 'node:child_process'
import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'

import { defineCommand } from 'citty'
import { debounce } from 'perfect-debounce'
import * as rolldown from 'rolldown'
import { parse } from 'rolldown/utils'

import { buildNeem } from './internal/commands/build.ts'
import { devNeem } from './internal/commands/dev.ts'
import { startNeem } from './internal/commands/start.ts'
import { createNeemTestProbe } from './internal/runtime/test-probe.ts'

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
      description: 'Output directory. Overrides config outDir.',
    },
  },
  async run({ args }) {
    await buildNeem({
      config: args.config,
      outDir: args.outDir,
      runtimes: parseRuntimes(args.runtime),
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
      default: 'neem.config.ts',
    },
    outDir: {
      type: 'string',
      description: 'Development output directory.',
      default: '.neem',
    },
    runtime: {
      type: 'positional',
      description: 'Comma-separated runtime names to start in dev.',
      required: false,
    },
  },
  async run({ args, data }) {
    if (data) {
      const probe = createNeemTestProbe()
      const controller = createCliAbortController()
      probe?.emit('cli:dev:start')

      try {
        const host = await devNeem({
          config: args.config,
          outDir: args.outDir,
          runtimes: parseRuntimes(args.runtime),
          hooks: probe?.hooks,
          signal: controller?.signal,
        })
        await host.closed
        probe?.emit('cli:dev:closed')
      } finally {
        controller.dispose()
      }
    } else {
      const self = process.argv[1]
      const forkArgs = ['--config', args.config, '--outDir', args.outDir]
      if (args.runtime) forkArgs.push(args.runtime)

      let forked: ChildProcess | null = null
      let watcher: rolldown.RolldownWatcher | null = null

      const startWatcher = debounce(() => {
        watcher?.close()

        watcher = rolldown.watch({
          input: resolve(args.config),
          platform: 'node',
          logLevel: 'warn',
          external: (id) => {
            return isBuiltin(id)
          },
          output: {
            file: resolve(args.outDir, 'neem.config.js'),
            minify: false,
            codeSplitting: false,
            sourcemap: false,
          },
          experimental: { chunkOptimization: false },
          optimization: { inlineConst: false, pifeForModuleWrappers: false },
          treeshake: false,
          watch: {
            buildDelay: 100,
            clearScreen: false,
            skipWrite: true,
            exclude: 'node_modules/**',
            watcher: {
              debounceDelay: 50,
              useDebounce: true,
              usePolling: true,
              compareContentsForPolling: true,
            },
          },
        })

        
        let initial = true
        
        watcher.on('event', (event) => {
          switch (event.code) {
            case 'END': {
              if(!initial) {
                startWatcher()
              } else {
                startProcess()
                initial = false
              }
              break
            }
          }
        })
      }, 250)

      const startProcess = debounce(async () => {
        forked?.kill()
        forked = fork(self, forkArgs, {
          execArgv: ['--expose-gc'],
          stdio: 'inherit',
          env: { ...process.env, NEEM_DEV_PROCESS: '1' },
        })
        forked?.on('message', (msg) => {
          process.send?.(msg)
        })
      }, 250)

      const shutdown = () => {
        void (async () => {
          await watcher?.close()
          watcher = null
          const child = forked
          forked = null
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM')
            await waitForProcessExit(child).catch(() => undefined)
          }
          process.exit(0)
        })()
      }

      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
      startWatcher()
    }
  },
})

export const startCommand = defineCommand({
  meta: { name: 'start', description: 'Start a built Neem runtime server.' },
  args: {
    outDir: {
      type: 'string',
      description: 'Built output directory.',
      default: 'dist',
    },
    runtime: {
      type: 'positional',
      description: 'Comma-separated runtime names to start.',
      required: false,
    },
  },
  async run({ args, data }) {
    const controller = createCliAbortController()
    const probe = createNeemTestProbe()
    probe?.emit('cli:start:start')

    try {
      const host = await startNeem({
        outDir: args.outDir,
        runtimes: parseRuntimes(args.runtime),
        hooks: probe?.hooks,
        signal: controller.signal,
      })
      await host.closed
      probe?.emit('cli:start:closed')
    } finally {
      controller.dispose()
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

function waitForProcessExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
  })
}
