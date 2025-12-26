#!/usr/bin/env node --enable-source-maps

import { once } from 'node:events'
import { relative, resolve } from 'node:path'
import process from 'node:process'

import type { ArgDef } from 'citty'
import { defineCommand, runMain } from 'citty'
import { config as dotenv } from 'dotenv'

import type { NeemataConfig } from './config.ts'
import type { ViteConfigOptions } from './vite/config.ts'
import { resolver } from './resolver.ts'
import { generateTypings } from './typings.ts'
import { createBuilder } from './vite/builder.ts'
import { baseViteConfigOptions } from './vite/config.ts'
import { createMainServer } from './vite/servers/main.ts'

// import { createMainRunner } from './vite/runner.ts'

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
let applicationImports: Record<
  string,
  { path: string; specifier: string; type: 'neemata' | 'custom' }
>

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

    // const applicationEntryPaths: Record<string, string> = {}
    applicationImports = {}
    const currentPkg = resolver.sync(process.cwd(), './package.json')

    for (const [appName, { specifier: appSpecifier, type }] of Object.entries(
      config.applications,
    )) {
      const resolution = resolver.sync(process.cwd(), appSpecifier)
      if (resolution.error)
        throw new Error(
          `Failed to resolve application path for ${appName}: ${resolution.error}`,
        )
      if (!resolution.path)
        throw new Error(
          `Failed to resolve application path for ${appName}: no path found`,
        )
      const specifier =
        resolution.packageJsonPath === currentPkg.path
          ? relative(resolve('.neemata'), resolution.path)
          : appSpecifier
      applicationImports[appName] = { path: resolution.path, specifier, type }
    }

    viteConfigOptions = {
      applicationImports,
      serverEntryPath: resolve(config.serverPath),
      ...baseViteConfigOptions,
      configPath,
    }
  },
  subCommands: {
    prepare: defineCommand({
      async run(ctx) {
        await generateTypings(applicationImports)
      },
    }),
    dev: defineCommand({
      async run(ctx) {
        const { runner } = await createMainServer(
          viteConfigOptions,
          'development',
          config,
        )
        await runner.import(viteConfigOptions.entrypointMainPath)
        await once(process, 'beforeExit')
      },
    }),
    preview: defineCommand({
      async run(ctx) {
        const { runner } = await createMainServer(
          viteConfigOptions,
          'production',
          config,
        )
        await runner.import(viteConfigOptions.entrypointMainPath)
        await once(process, 'beforeExit')
      },
    }),
    build: defineCommand({
      async run(ctx) {
        const builder = await createBuilder(viteConfigOptions, config)
        await builder.build()
      },
    }),
    // command: defineCommand({
    //   async run(ctx) {
    //     const runner = await createRunner(
    //       viteConfigOptions,
    //       'production',
    //       config,
    //     )
    //     const workerModule = await runner.import<
    //       typeof import('./entrypoints/worker.ts')
    //     >(import.meta.resolve('./entrypoints/worker.js'))
    //     const commandModule = await runner.import<
    //       typeof import('./command.ts')
    //     >(import.meta.resolve('./command.js'))
    //     const worker = await workerModule.default({
    //       applicationWorkerData: undefined,
    //       type: ApplicationType.Command,
    //       workerType: ApplicationWorkerType.Command,
    //     })
    //     await runMain(commandModule.default(worker), { rawArgs: ctx.rawArgs })
    //   },
    // }),
  },
})

runMain(mainCommand)
