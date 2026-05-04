import { pathToFileURL } from 'node:url'

import { defineCommand, runCommand, showUsage } from 'citty'

import { buildNeem } from './internal/build.ts'
import { startNeem } from './internal/start.ts'

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
    dev: createReservedCommand('dev'),
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
        const controller = new AbortController()
        const abort = () => controller.abort()
        process.once('SIGINT', abort)
        process.once('SIGTERM', abort)

        try {
          const host = await startNeem({
            outDir: args.outDir,
            signal: controller.signal,
          })
          console.log(`Neem started from ${host.outDir}`)
          await host.closed
        } finally {
          process.off('SIGINT', abort)
          process.off('SIGTERM', abort)
        }
      },
    }),
  },
})

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    await showUsage(mainCommand)
    return 0
  }

  const subCommand = mainCommand.subCommands?.[argv[0] as 'build' | 'start']
  if (subCommand && (argv[1] === '--help' || argv[1] === '-h')) {
    await showUsage(subCommand as any, mainCommand as any)
    return 0
  }

  await runCommand(mainCommand, { rawArgs: argv })
  return 0
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

function createReservedCommand(command: string) {
  return defineCommand({
    meta: {
      name: command,
      description:
        'Reserved for a later slice. Only `neem build` is wired now.',
    },
    run() {
      throw new Error(
        `Command [${command}] is reserved for a later Neem slice and is not wired yet.`,
      )
    },
  })
}
