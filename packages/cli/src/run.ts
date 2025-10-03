#!/usr/bin/env node --watch-preserve-output

import { fork } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import type { ApplicationWorkerOptions } from '@nmtjs/application'
import { APP_COMMAND, Application, WorkerType } from '@nmtjs/application'
import { defer } from '@nmtjs/common'
import { ApplicationServer } from '@nmtjs/server'
import { config } from 'dotenv'

export const run = async (scriptPath: string) => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      entry: { type: 'string', multiple: false },
      watch: { type: 'boolean', multiple: false, default: false },
      ts: { type: 'boolean', multiple: false, default: false },
      timeout: { type: 'string', multiple: false },
      env: { type: 'string', multiple: true, default: [] },
    },
  })

  const [command, ...args] = positionals
  const { env: envPaths, ts, watch, entry, swc, timeout, ...kwargs } = values

  const shutdownTimeout =
    (typeof timeout === 'string' ? Number.parseInt(timeout) : undefined) || 1000

  for (const env of envPaths as string[]) {
    if (typeof env === 'string') {
      const { error } = config({ path: env })
      if (error) console.warn(error)
    }
  }

  if (watch || ts) {
    const args = process.argv
      .slice(2)
      .filter((arg) => !['--watch', '--ts'].includes(arg))
    const execArgs = [...process.execArgv, '--watch-preserve-output']
    if (ts)
      execArgs.push(
        '--enable-source-maps',
        '--experimental-strip-types',
        '--experimental-transform-types',
      )
    if (watch) execArgs.push('--watch')
    fork(fileURLToPath(scriptPath), args, {
      execArgv: execArgs,
      env: { ...process.env, NEEMATA_WATCH: watch ? 'true' : undefined },
      stdio: 'inherit',
    })
  } else {
    const loadEntry = async () => {
      const entryPath = resolve(
        process.env.NEEMATA_ENTRY ||
          (typeof entry === 'string' ? entry : swc ? 'index.ts' : 'index.js'),
      )

      let exitTimeout: any

      const exitProcess = () => {
        if (exitTimeout) clearTimeout(exitTimeout)
        process.exit(0)
      }

      const tryExit = async (cb: any) => {
        if (exitTimeout) return
        exitTimeout = setTimeout(exitProcess, shutdownTimeout)
        try {
          await cb()
        } catch (error) {
          logger.error(error)
        } finally {
          exitProcess()
        }
      }

      const entryAppFn = await import(entryPath).then(
        (module) => module.default,
      )

      if (typeof entryAppFn !== 'function') {
        throw new Error(
          'Invalid entry module. Must be a function that returns an instance of Application or ApplicationServer',
        )
      }

      const options: ApplicationWorkerOptions = {
        id: 0,
        workerType: WorkerType.Api,
        isServer: false,
        workerOptions: undefined,
      }
      const entryApp = await entryAppFn(options)
      const isCorrectInstance =
        entryApp instanceof ApplicationServer || entryApp instanceof Application

      if (!isCorrectInstance) {
        throw new Error(
          'Invalid entry module. Must be an instance of Application or ApplicationServer',
        )
      }

      const { logger } = entryApp

      process.on('uncaughtException', (error) => logger.error(error))
      process.on('unhandledRejection', (error) => logger.error(error))

      return { entryApp, tryExit }
    }

    const loadApp = async (
      entryApp: ApplicationServer | Application,
      workerType: WorkerType,
      workerOptions = {},
    ) => {
      let app: Application

      if (entryApp instanceof ApplicationServer) {
        const { applicationPath } = entryApp.options
        const path =
          typeof applicationPath === 'string'
            ? resolve(applicationPath)
            : fileURLToPath(applicationPath)
        const options: ApplicationWorkerOptions = {
          id: 0,
          workerType,
          isServer: false,
          workerOptions,
        }

        const factory = await import(path).then((module) => module.default)
        if (typeof factory !== 'function') {
          throw new Error(
            'Invalid application module. Must be a function that returns an instance of Application',
          )
        }

        app = await factory(options)
      } else {
        app = entryApp as Application
      }

      return app
    }

    const commands = {
      async start() {
        const { entryApp, tryExit } = await loadEntry()
        const terminate = () => tryExit(() => entryApp.stop())
        process.on('SIGTERM', terminate)
        process.on('SIGINT', terminate)
        await entryApp.start()
      },
      async execute() {
        const { entryApp, tryExit } = await loadEntry()
        const app = await loadApp(entryApp, WorkerType.Task)

        const [inputCommand, ...commandArgs] = args

        let [extension, commandName] = inputCommand.split(':')

        if (!commandName) {
          commandName = extension
          // @ts-expect-error
          extension = undefined
        }

        const terminate = () => tryExit(() => defer(() => app.stop()))

        process.on('SIGTERM', terminate)
        process.on('SIGINT', terminate)

        await app.initialize()

        const command = app.registry.commands
          .get(extension ?? APP_COMMAND)
          ?.get(commandName)

        if (!command)
          throw new Error(`Unknown application command: ${commandName}`)

        try {
          await command({ args: commandArgs, kwargs })
        } finally {
          terminate()
        }
      },
    }

    if (command in commands === false)
      throw new Error(`Unknown CLI command: ${command}`)

    commands[command]()
  }
}
