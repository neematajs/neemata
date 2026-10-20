import * as NodeServices from '@effect/platform-node/NodeServices'
import { Argument, Command, Flag } from 'effect/cli'
import * as Effect from 'effect/Effect'

import type {
  BuildCommandOptions,
  DevCommandOptions,
  PreviewCommandOptions,
  StartCommandOptions,
} from './internal/commands/cli.ts'
import { cliAction } from './internal/cli-action.ts'
import {
  runBuildCommand,
  runDevCommand,
  runPreviewCommand,
  runStartCommand,
} from './internal/commands/cli.ts'

export type CommandActions = {
  build: (options: BuildCommandOptions, signal: AbortSignal) => Promise<void>
  dev: (options: DevCommandOptions, signal: AbortSignal) => Promise<void>
  preview: (
    options: PreviewCommandOptions,
    signal: AbortSignal,
  ) => Promise<void>
  start: (options: StartCommandOptions, signal: AbortSignal) => Promise<void>
}

const actions: CommandActions = {
  build: (options) => runBuildCommand(options),
  dev: (options, signal) => runDevCommand(options, signal),
  preview: (options, signal) => runPreviewCommand(options, signal),
  start: (options, signal) => runStartCommand(options, signal),
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
const envFiles = Flag.String('env-files').pipe(
  Flag.withDefault(undefined),
  Flag.withDescription(
    'Comma-separated env files; existing variables and earlier files win.',
  ),
)

/** Command actions stay separate from CLI parsing and signal handling. */
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
      'env-files': envFiles,
    },
    (options) => cliAction((signal) => handlers.dev(options, signal)),
  ).pipe(
    Command.withDescription(
      'Start a watched development server (default output: .neem/<config name>).',
    ),
  )
  const preview = Command.make(
    'preview',
    {
      runtime,
      config: config.pipe(Flag.withDefault('neem.config.ts')),
      outDir,
      'env-files': envFiles,
    },
    (options) => cliAction((signal) => handlers.preview(options, signal)),
  ).pipe(
    Command.withDescription(
      'Build with source maps and serve the production output (default output: .neem/preview/<config name>).',
    ),
  )
  return Command.make('neem').pipe(
    Command.withDescription('Neem host powered by Effect.'),
    Command.withSubcommands([build, dev, preview, start]),
  )
}

export const mainCommand = createMainCommand()

export const runCli = (args: readonly string[], version: string) =>
  Command.runWith(mainCommand, { version })(args).pipe(
    Effect.provide(NodeServices.layer),
  )
