import { parentPort, workerData } from 'node:worker_threads'

if (!parentPort)
  throw new Error('Dev runtime test worker requires a parent port')

const port = parentPort
const format = (value) => {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
const logger = Object.fromEntries(
  ['fatal', 'error', 'warn', 'info', 'debug', 'trace'].map((level) => [
    level,
    (...args) =>
      port.postMessage({
        type: 'log',
        level,
        message: args.map(format).join(' '),
      }),
  ]),
)

try {
  const createRuntime = (await import(workerData.moduleUrl)).default
  const runtime = createRuntime({ logger }, workerData.options)
  port.on('message', (message) => {
    if (message?.type !== 'stop') return
    void runtime
      .stop()
      .then(() => {
        port.postMessage({ type: 'stopped' })
        port.close()
      })
      .catch((error) =>
        port.postMessage({ type: 'error', message: format(error) }),
      )
  })
  const upstreams = await runtime.start()
  port.postMessage({ type: 'ready', upstreams })
} catch (error) {
  port.postMessage({ type: 'error', message: format(error) })
}
