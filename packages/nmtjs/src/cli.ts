#!/usr/bin/env node --enable-source-maps

import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'

import type { ArgDef } from 'citty'
import { defineCommand, runMain } from 'citty'
import { config as dotenv } from 'dotenv'

import type { NeemataConfig } from './config.ts'
import type { ViteConfigOptions } from './vite/config.ts'
import { generateTypings } from './codegen.ts'
import { resolver } from './resolver.ts'
import { createBuilder } from './vite/builder.ts'
import { baseViteConfigOptions } from './vite/config.ts'
import { createMainServer } from './vite/servers/main.ts'

const commonArgs = {
  config: {
    type: 'string',
    alias: 'c',
    description: 'Path to Neemata config file',
    required: false,
  },
} satisfies Record<string, ArgDef>

function resolveConfigPath(configPathArg: string | undefined): string {
  if (configPathArg) {
    return resolve(configPathArg)
  }

  const tsConfigPath = resolve('./neemata.config.ts')
  if (existsSync(tsConfigPath)) {
    return tsConfigPath
  }

  const jsConfigPath = resolve('./neemata.config.js')
  if (existsSync(jsConfigPath)) {
    return jsConfigPath
  }

  throw new Error(
    'Failed to resolve Neemata config file. Create neemata.config.ts or neemata.config.js, or pass --config.',
  )
}

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
    const configPath = resolveConfigPath(ctx.args.config as string | undefined)
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
