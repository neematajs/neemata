import { fileURLToPath } from 'node:url'

import type { ServerConfig } from '@nmtjs/runtime'
import { ApplicationServer, isServerConfig } from '@nmtjs/runtime'

declare global {
  const __VITE_CONFIG__: string
  const __APPLICATIONS_CONFIG__: string
}

let config: ServerConfig

class InvalidServerConfigError extends Error {
  constructor() {
    super(
      `Server config file does not have a default export, or it not a valid application. Please, make sure the application is defined using defineApplication().`,
    )
    this.name = 'InvalidServerConfigError'
  }
}

if (import.meta.env.DEV && import.meta.hot) {
  import.meta.hot.accept('#server', (module) => {
    config = module?.default
    if (!isServerConfig(config)) throw new InvalidServerConfigError()
    server.stop().then(() => server.start())
  })
}

config = await import(
  // @ts-expect-error
  '#server'
).then((m) => m.default)

if (!isServerConfig(config)) throw new InvalidServerConfigError()

const vite = __VITE_CONFIG__ || undefined
const applicationsConfig = __APPLICATIONS_CONFIG__

const server = new ApplicationServer(config, {
  path: fileURLToPath(import.meta.resolve('./thread')),
  workerData: { vite: vite && JSON.parse(vite) },
})

let isTerminating = false

async function handleTermination() {
  console.log('Gracefull termination...')
  if (isTerminating) return
  isTerminating = true
  await server.stop()
  process.exit(0)
}

process.once('SIGTERM', handleTermination)
process.once('SIGINT', handleTermination)
process.on('uncaughtException', (error) => console.error(error))
process.on('unhandledRejection', (error) => console.error(error))

server.start()
