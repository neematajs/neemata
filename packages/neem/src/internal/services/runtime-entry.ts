import { parentPort } from 'node:worker_threads'

import type { RuntimeRequest, RuntimeResponse } from './protocol.ts'
import { serializeError } from '../shared/utils.ts'
import { RuntimeService } from './runtime.ts'

if (!parentPort) {
  throw new Error('Neem runtime service requires a parent port')
}

const port = parentPort
const service = new RuntimeService()

function post(message: RuntimeResponse): void {
  port.postMessage(message)
}

async function handle(request: RuntimeRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'start': {
        const health = await service.start({
          mode: request.mode,
          outDir: request.outDir,
          manifestFile: request.manifestFile,
          runtimes: request.runtimes,
          emit: (event) => post({ type: 'event', event }),
        })
        post({ id: request.id, type: 'result', data: { health } })
        return
      }
      case 'reload': {
        const health = await service.reload(request.manifestFile)
        post({ id: request.id, type: 'result', data: { health } })
        return
      }
      case 'reload-runtime': {
        const health = await service.reloadRuntime(
          request.runtimeName,
          request.manifestFile,
        )
        post({ id: request.id, type: 'result', data: { health } })
        return
      }
      case 'stop':
        await service.stop()
        post({ id: request.id, type: 'result' })
        post({ type: 'event', event: { type: 'stopped' } })
        port.close()
        return
    }
  } catch (error) {
    post({ id: request.id, type: 'error', error: serializeError(error) })
  }
}

port.on('message', (message: RuntimeRequest) => {
  void handle(message)
})
