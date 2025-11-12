#!/usr/bin/env node --enable-source-maps

import { once } from 'node:events'
import { resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

import type { ArgDef } from 'citty'
import { ApplicationType, ApplicationWorkerType } from '@nmtjs/application'
import { defineCommand, runCommand, runMain } from 'citty'
import { config as dotenv } from 'dotenv'

import type { NeemataConfig } from './config.ts'
import type { ViteConfigOptions } from './vite/config.ts'
import { createBuilder } from './vite/builder.ts'
import { baseViteConfigOptions } from './vite/config.ts'
import { createRunner } from './vite/runner.ts'

const commonArgs = {
  config: {
    type: 'string',
    alias: 'c',
    default: './neemata.config.ts',
    description: 'Path to Neemata config file',
    required: false,
  },
} satisfies Record<string, ArgDef>

let config: NeemataConfig
let viteConfigOptions: ViteConfigOptions

const mainCommand = defineCommand({
  meta: { description: 'Neemata CLI' },
  args: { ...commonArgs },
  async setup(ctx) {
    const configPath = resolve(ctx.args.config as string)
    config = await import(configPath).then((m) => m.default)

    for (const env of config.env) {
      if (typeof env === 'string') {
        const { error } = dotenv({ path: env })
        if (error) console.warn(error)
      } else if (typeof env === 'object') {
        for (const key in env) {
          process.env[key] = env[key]
        }
      }
    }

    viteConfigOptions = {
      applicationEntryPath: resolve(config.applicationPath),
      serverEntryPath: resolve(config.serverPath),
      ...baseViteConfigOptions,
      configPath,
    }
  },
  subCommands: {
    dev: defineCommand({
      async run(ctx) {
        const runner = await createRunner(
          viteConfigOptions,
          'development',
          config,
        )
        await runner.import(viteConfigOptions.entrypointServerPath)
      },
    }),
    preview: defineCommand({
      async run(ctx) {
        const runner = await createRunner(
          viteConfigOptions,
          'production',
          config,
        )
        await runner.import(viteConfigOptions.entrypointServerPath)
        await once(process, 'beforeExit')
      },
    }),
    command: defineCommand({
      async run(ctx) {
        const runner = await createRunner(
          viteConfigOptions,
          'production',
          config,
        )
        const workerModule = await runner.import<
          typeof import('./entrypoints/worker.ts')
        >(import.meta.resolve('./entrypoints/worker.js'))
        const commandModule = await runner.import<
          typeof import('./command.ts')
        >(import.meta.resolve('./command.js'))
        const worker = await workerModule.default({
          applicationWorkerData: undefined,
          type: ApplicationType.Command,
          workerType: ApplicationWorkerType.Command,
        })
        await runMain(commandModule.default(worker), { rawArgs: ctx.rawArgs })
      },
    }),
    build: defineCommand({
      async run(ctx) {
        const builder = await createBuilder(viteConfigOptions, config)
        await builder.build()
      },
    }),
  },
})

runMain(mainCommand)
