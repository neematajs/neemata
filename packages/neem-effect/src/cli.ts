import type {
  BuildCommandOptions,
  DevCommandOptions,
  StartCommandOptions,
} from '@nmtjs/neem/internal/commands/cli'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  runBuildCommand,
  runDevCommand,
  runStartCommand,
} from '@nmtjs/neem/internal/commands/cli'
import { Argument, Command, Flag } from 'effect/cli'
import * as Effect from 'effect/Effect'

import { neemEffectFlavor } from './flavor.ts'
import { cliAction } from './internal/cli-action.ts'

export type CommandActions = {
  build: (options: BuildCommandOptions, signal: AbortSignal) => Promise<void>
  dev: (options: DevCommandOptions, signal: AbortSignal) => Promise<void>
  start: (options: StartCommandOptions, signal: AbortSignal) => Promise<void>
}

const actions: CommandActions = {
  build: (options) => runBuildCommand(options, neemEffectFlavor),
  dev: (options, signal) => runDevCommand(options, neemEffectFlavor, signal),
  start: (options, signal) =>
    runStartCommand(options, neemEffectFlavor, signal),
}

const runtime = Argument.String('runtime').pipe(
  Argument.withDescription('Comma-separated runtime names.'),
  Argument.withDefault(undefined),
)
const config = Flag.String('config').pipe(
  Flag.withDescription('Path to neem.config file.'),
)
const outDir = Flag.String('out-dir').pipe(
  Flag.withAlias('outDir'),
  Flag.withDescription(
    'Output directory relative to cwd; overrides the config.',
  ),
  Flag.withDefault(undefined),
)

/** Command actions are separate from parsing so both host CLIs share behavior. */
export function createMainCommand(handlers: CommandActions = actions) {
  const build = Command.make(
    'build',
    {
      runtime,
      config: config.pipe(Flag.withDefault('neem.config.ts')),
      outDir,
    },
    (options) => cliAction((signal) => handlers.build(options, signal)),
  ).pipe(Command.withDescription('Build Neem config and runtime artifacts.'))
  const start = Command.make(
    'start',
    {
      runtime,
      config: config.pipe(Flag.withDefault(undefined)),
      outDir,
    },
    (options) => cliAction((signal) => handlers.start(options, signal)),
  ).pipe(
    Command.withDescription(
      'Start a built Neem runtime server (default output: dist).',
    ),
  )
  const dev = Command.make(
    'dev',
    {
      runtime,
      config: config.pipe(Flag.withDefault('neem.config.ts')),
      outDir,
      cache: Flag.Boolean('cache').pipe(
        Flag.withDefault(true),
        Flag.withDescription(
          'Enable Node.js compile cache; --no-cache disables it.',
        ),
      ),
      cacheDir: Flag.String('cache-dir').pipe(
        Flag.withAlias('cacheDir'),
        Flag.withDefault(undefined),
        Flag.withDescription('Directory for Node.js compile cache.'),
      ),
      'env-files': Flag.String('env-files').pipe(
        Flag.withDefault(undefined),
        Flag.withDescription(
          'Comma-separated env files; existing variables and earlier files win.',
        ),
      ),
    },
    (options) => cliAction((signal) => handlers.dev(options, signal)),
  ).pipe(
    Command.withDescription(
      'Start a watched development server (default output: .neem/<config name>).',
    ),
  )
  return Command.make('neem-effect').pipe(
    Command.withDescription('Neem host powered by Effect.'),
    Command.withSubcommands([build, dev, start]),
  )
}

export const mainCommand = createMainCommand()

export const runCli = (args: readonly string[], version: string) =>
  Command.runWith(mainCommand, { version })(args).pipe(
    Effect.provide(NodeServices.layer),
  )
