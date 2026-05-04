import { pathToFileURL } from 'node:url'

import { defineCommand, runCommand, showUsage } from 'citty'

import { buildNeem } from './internal/build.ts'
import { devNeem } from './internal/dev.ts'
import { startNeem } from './internal/start.ts'

export type NeemCliMainOptions = { signal?: AbortSignal }

let currentMainSignal: AbortSignal | undefined

const buildCommand = defineCommand({
  meta: {
    name: 'build',
    description: 'Build Neem config, app entries, and plugin artifacts.',
  },
  args: {
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
    const result = await buildNeem({ config: args.config, outDir: args.outDir })

    console.log(`Neem build written to ${result.outDir}`)
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
      },
      async run({ args }) {
        const controller = createCliAbortController()

        try {
          const host = await devNeem({
            config: args.config,
            outDir: args.outDir,
            signal: controller.signal,
          })
          console.log(`Neem dev watching ${host.configFile}`)
          await host.closed
        } finally {
          controller.dispose()
        }
      },
    }),
    start: defineCommand({
      meta: {
        name: 'start',
        description: 'Start a built Neem application server.',
      },
      args: {
        outDir: {
          type: 'string',
          description: 'Built output directory.',
          default: 'dist',
        },
      },
      async run({ args }) {
        const controller = createCliAbortController()

        try {
          const host = await startNeem({
            outDir: args.outDir,
            signal: controller.signal,
          })
          console.log(`Neem started from ${host.outDir}`)
          await host.closed
        } finally {
          controller.dispose()
        }
      },
    }),
  },
})

export async function main(
  argv = process.argv.slice(2),
  options: NeemCliMainOptions = {},
): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    await showUsage(mainCommand)
    return 0
  }

  const subCommand =
    mainCommand.subCommands?.[argv[0] as 'build' | 'dev' | 'start']
  if (subCommand && (argv[1] === '--help' || argv[1] === '-h')) {
    await showUsage(subCommand as any, mainCommand as any)
    return 0
  }

  currentMainSignal = options.signal
  try {
    await runCommand(mainCommand, { rawArgs: argv })
    return 0
  } finally {
    currentMainSignal = undefined
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

function createCliAbortController() {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const abortFromMainSignal = () => controller.abort()

  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  currentMainSignal?.addEventListener('abort', abortFromMainSignal, {
    once: true,
  })

  if (currentMainSignal?.aborted) controller.abort()

  return {
    signal: controller.signal,
    dispose() {
      process.off('SIGINT', abort)
      process.off('SIGTERM', abort)
      currentMainSignal?.removeEventListener('abort', abortFromMainSignal)
    },
  }
}
