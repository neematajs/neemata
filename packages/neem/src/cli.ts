import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { defineCommand, runMain } from 'citty'

import { startNeemServer } from './runtime/server/bootstrap.ts'
import { isServerConfig } from './runtime/server/config.ts'

const mainCommand = defineCommand({
  meta: { description: 'Neem CLI' },
  subCommands: {
    start: defineCommand({
      meta: { description: 'Start neem application server' },
      args: {
        server: {
          type: 'string',
          required: true,
          description: 'Path to module that default-exports defineServer(...)',
        },
        applications: {
          type: 'string',
          required: true,
          description:
            'Path to module that default-exports application specifiers map',
        },
        worker: {
          type: 'string',
          required: true,
          description: 'Path to worker thread entrypoint',
        },
        mode: { type: 'string', required: false, default: 'development' },
      },
      async run(ctx) {
        const mode =
          ctx.args.mode === 'production' ? 'production' : 'development'

        const serverPath = pathToFileURL(resolve(String(ctx.args.server))).href
        const applicationsPath = pathToFileURL(
          resolve(String(ctx.args.applications)),
        ).href
        const workerPath = resolve(String(ctx.args.worker))

        const serverConfig = await import(
          /* @vite-ignore */
          serverPath
        ).then((m) => m.default)

        if (!isServerConfig(serverConfig)) {
          throw new Error(
            'Invalid server config. Ensure module default-export is defineServer(...) result.',
          )
        }

        const applicationsConfig = (await import(
          /* @vite-ignore */
          applicationsPath
        ).then((m) => m.default)) as Record<string, { specifier: string }>

        await startNeemServer({
          config: serverConfig,
          applicationsConfig,
          workerConfig: { path: workerPath },
          mode,
          setupProcessHandlers: true,
        })
      },
    }),
  },
})

runMain(mainCommand)
