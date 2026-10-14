import { defineCommand } from 'citty'

import type { NeemHostFlavor } from './internal/flavor.ts'
import {
  runBuildCommand,
  runDevCommand,
  runStartCommand,
} from './internal/commands/cli.ts'

function createBuildCommand(flavor?: NeemHostFlavor) {
  return defineCommand({
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
    run: ({ args }) => runBuildCommand(args, flavor),
  })
}

function createStartCommand(flavor?: NeemHostFlavor) {
  return defineCommand({
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
    run: ({ args }) => runStartCommand(args, flavor),
  })
}

function createDevCommand(flavor?: NeemHostFlavor) {
  return defineCommand({
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
    run: ({ args }) => runDevCommand(args, flavor),
  })
}

export function createMainCommand(flavor?: NeemHostFlavor) {
  return defineCommand({
    meta: { name: flavor?.name ?? 'neem', description: 'Neem host CLI.' },
    subCommands: {
      build: createBuildCommand(flavor),
      dev: createDevCommand(flavor),
      start: createStartCommand(flavor),
    },
  })
}

export const buildCommand = createBuildCommand()
export const startCommand = createStartCommand()
export const devCommand = createDevCommand()
export const mainCommand = createMainCommand()
