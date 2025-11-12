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
// import command from './command.ts'
import { createBuilder } from './vite/builder.ts'
import { baseViteConfigOptions } from './vite/config.ts'
import { createRunner } from './vite/runner.ts'

// const { values, positionals } = parseArgs({
//   allowPositionals: true,
//   strict: false,
//   options: {
//     config: { type: 'string', multiple: false, default: './neemata.config.ts' },
//   },
// })

// const [command, ...args] = positionals

// const configPath = resolve(values.config as string)

// const config: NeemataConfig = await import(configPath).then((m) => m.default)

// for (const env of config.env) {
//   if (typeof env === 'string') {
//     const { error } = dotenv({ path: env })
//     if (error) console.warn(error)
//   } else if (typeof env === 'object') {
//     for (const key in env) {
//       process.env[key] = env[key]
//     }
//   }
// }

// const configOptions: ViteConfigOptions = {
//   applicationEntryPath: resolve(config.applicationPath),
//   serverEntryPath: resolve(config.serverPath),
//   ...baseViteConfigOptions,
//   configPath,
// }

// const commands = {
//   async dev() {
//     const runner = await createRunner(configOptions, 'development', config)
//     await runner.import(configOptions.entrypointServerPath)
//   },
//   async preview() {
//     const runner = await createRunner(configOptions, 'production', config)
//     await runner.import(configOptions.entrypointServerPath)
//   },
//   async command() {
//     const runner = await createRunner(configOptions, 'production', config)
//     await runner.import(configOptions.entrypointServerPath)
//   },
//   async build() {
//     const builder = await createBuilder(configOptions, config)
//     await builder.build()
//   },
// }

// if (command in commands === false)
//   throw new Error(`Unknown CLI command: ${command}`)

// await commands[command]()

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

// const shutdownTimeout =
//   (typeof timeout === 'string' ? Number.parseInt(timeout) : undefined) || 1000

// if (watch || ts) {
//   const args = process.argv
//     .slice(2)
//     .filter((arg) => !['--watch', '--ts'].includes(arg))
//   const execArgs = [...process.execArgv, '--watch-preserve-output']
//   if (ts)
//     execArgs.push(
//       '--enable-source-maps',
//       '--experimental-strip-types',
//       '--experimental-transform-types',
//     )
//   if (watch) execArgs.push('--watch')
//   fork(fileURLToPath(scriptPath), args, {
//     execArgv: execArgs,
//     env: { ...process.env, NEEMATA_WATCH: watch ? 'true' : undefined },
//     stdio: 'inherit',
//   })
// } else {
//   const loadEntry = async () => {
//     const entryPath = resolve(
//       process.env.NEEMATA_ENTRY ||
//         (typeof entry === 'string' ? entry : swc ? 'index.ts' : 'index.js'),
//     )

//     let exitTimeout: any

//     const exitProcess = () => {
//       if (exitTimeout) clearTimeout(exitTimeout)
//       process.exit(0)
//     }

//     const tryExit = async (cb: any) => {
//       if (exitTimeout) return
//       exitTimeout = setTimeout(exitProcess, shutdownTimeout)
//       try {
//         await cb()
//       } catch (error) {
//         logger.error(error)
//       } finally {
//         exitProcess()
//       }
//     }

//     const entryAppFn = await import(entryPath).then(
//       (module) => module.default,
//     )

//     if (typeof entryAppFn !== 'function') {
//       throw new Error(
//         'Invalid entry module. Must be a function that returns an instance of Application or ApplicationServer',
//       )
//     }

//     const options: ApplicationWorkerOptions = {
//       id: 0,
//       workerType: WorkerType.Api,
//       isServer: false,
//       workerOptions: undefined,
//     }
//     const entryApp = await entryAppFn(options)
//     const isCorrectInstance =
//       entryApp instanceof ApplicationServer || entryApp instanceof Application

//     if (!isCorrectInstance) {
//       throw new Error(
//         'Invalid entry module. Must be an instance of Application or ApplicationServer',
//       )
//     }

//     const { logger } = entryApp

//     process.on('uncaughtException', (error) => logger.error(error))
//     process.on('unhandledRejection', (error) => logger.error(error))

//     return { entryApp, tryExit }
//   }

//   const loadApp = async (
//     entryApp: ApplicationServer | Application,
//     workerType: WorkerType,
//     workerOptions = {},
//   ) => {
//     let app: Application

//     if (entryApp instanceof ApplicationServer) {
//       const { applicationPath } = entryApp.options
//       const path =
//         typeof applicationPath === 'string'
//           ? resolve(applicationPath)
//           : fileURLToPath(applicationPath)
//       const options: ApplicationWorkerOptions = {
//         id: 0,
//         workerType,
//         isServer: false,
//         workerOptions,
//       }

//       const factory = await import(path).then((module) => module.default)
//       if (typeof factory !== 'function') {
//         throw new Error(
//           'Invalid application module. Must be a function that returns an instance of Application',
//         )
//       }

//       app = await factory(options)
//     } else {
//       app = entryApp as Application
//     }

//     return app
//   }

//   const commands = {
//     async start() {
//       const { entryApp, tryExit } = await loadEntry()
//       const terminate = () => tryExit(() => entryApp.stop())
//       process.on('SIGTERM', terminate)
//       process.on('SIGINT', terminate)
//       await entryApp.start()
//     },
//     async execute() {
//       const { entryApp, tryExit } = await loadEntry()
//       const app = await loadApp(entryApp, WorkerType.Task)

//       const [inputCommand, ...commandArgs] = args

//       let [extension, commandName] = inputCommand.split(':')

//       if (!commandName) {
//         commandName = extension
//         // @ts-expect-error
//         extension = undefined
//       }

//       const terminate = () => tryExit(() => defer(() => app.stop()))

//       process.on('SIGTERM', terminate)
//       process.on('SIGINT', terminate)

//       await app.initialize()

//       const command = app.registry.commands
//         .get(extension ?? APP_COMMAND)
//         ?.get(commandName)

//       if (!command)
//         throw new Error(`Unknown application command: ${commandName}`)

//       try {
//         await command({ args: commandArgs, kwargs })
//       } finally {
//         terminate()
//       }
//     },
//   }

//   if (command in commands === false)
//     throw new Error(`Unknown CLI command: ${command}`)

//   commands[command]()
// }
