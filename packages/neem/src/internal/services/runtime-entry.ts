import { parentPort } from 'node:worker_threads'

import type { RuntimeRequest, RuntimeResponse } from './protocol.ts'
import { closeAndExit } from '../threads.ts'
import { serializeError } from '../utils.ts'
import { RuntimeService } from './runtime.ts'

if (!parentPort) {
  throw new Error('Neem runtime service requires a parent port')
}

const port = parentPort
let service: RuntimeService | undefined

function post(message: RuntimeResponse): void {
  port.postMessage(message)
}

async function handle(request: RuntimeRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'start': {
        service = new RuntimeService({
          mode: request.mode,
          outDir: request.outDir,
          env: request.env,
          runtimes: request.runtimes,
          emit: (event) => post({ type: 'event', event }),
        })
        const health = await service.start(request.manifestFile)
        post({ id: request.id, type: 'result', data: { health } })
        return
      }
      case 'reload-runtime': {
        const health = await requireService().reloadRuntime(
          request.runtimeName,
          request.manifestFile,
        )
        post({ id: request.id, type: 'result', data: { health } })
        return
      }
      case 'stop':
        await service?.stop()
        service = undefined
        post({ id: request.id, type: 'result' })
        post({ type: 'event', event: { type: 'stopped' } })
        return closeAndExit(port)
    }
  } catch (error) {
    post({ id: request.id, type: 'error', error: serializeError(error) })
  }
}

function requireService(): RuntimeService {
  if (!service) throw new Error('Neem runtime service is not started')
  return service
}

port.on('message', (message: RuntimeRequest) => {
  void handle(message)
})
