import { pathToFileURL } from 'node:url'

import { defineCommand, runCommand, showUsage } from 'citty'

import { buildNeem } from './internal/build.ts'

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
    start: createReservedCommand('start'),
  },
})

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    await showUsage(mainCommand)
    return 0
  }

  if (argv[0] === 'build' && (argv[1] === '--help' || argv[1] === '-h')) {
    await showUsage(buildCommand as any, mainCommand as any)
    return 0
  }

  await runCommand(mainCommand, { rawArgs: argv })
  return 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then((code) => {
    process.exitCode = code
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
