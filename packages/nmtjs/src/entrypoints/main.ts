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

const vite = __VITE_CONFIG__ ? JSON.parse(__VITE_CONFIG__) : undefined
const applicationsConfig = __APPLICATIONS_CONFIG__
  ? JSON.parse(__APPLICATIONS_CONFIG__)
  : {}

for (const key in applicationsConfig) {
  applicationsConfig[key] = import.meta.resolve(applicationsConfig[key])
}

const ext = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
const server = new ApplicationServer(config, applicationsConfig, {
  path: fileURLToPath(import.meta.resolve(`./thread${ext}`)),
  workerData: { vite },
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

const { format } = Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 2,
  unit: 'byte',
})
const printMem = () => {
  globalThis.gc?.()
  // print memory usage every 10 seconds
  const memoryUsage = process.memoryUsage()
  console.log(
    `Memory Usage: RSS=${format(memoryUsage.rss)}, HeapTotal=${format(memoryUsage.heapTotal)}, HeapUsed=${format(memoryUsage.heapUsed)}, External=${format(memoryUsage.external)}, ArrayBuffers=${format(memoryUsage.arrayBuffers)}`,
  )
}
printMem()
setInterval(printMem, 5000)
