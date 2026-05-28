import { defineCommand, runMain } from 'citty'

import { buildNeem } from './internal/commands/build.ts'
import { devNeem } from './internal/commands/dev.ts'
import { startNeem } from './internal/commands/start.ts'
import { createNeemTestProbe } from './internal/runtime/test-probe.ts'

const buildCommand = defineCommand({
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

const mainCommand = defineCommand({
  meta: { name: 'neem', description: 'Neem host CLI.' },
  subCommands: {
    build: buildCommand,
    dev: defineCommand({
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
      async run({ args }) {
        const controller = createCliAbortController()
        const probe = createNeemTestProbe()
        probe?.emit('cli:dev:start')

        try {
          const host = await devNeem({
            config: args.config,
            outDir: args.outDir,
            runtimes: parseRuntimes(args.runtime),
            hooks: probe?.hooks,
            signal: controller.signal,
          })
          await host.closed
          probe?.emit('cli:dev:closed')
        } finally {
          controller.dispose()
        }
      },
    }),
    start: defineCommand({
      meta: {
        name: 'start',
        description: 'Start a built Neem runtime server.',
      },
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
      async run({ args }) {
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
    }),
  },
})

export async function main(): Promise<void> {
  await runMain(mainCommand)
}

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
