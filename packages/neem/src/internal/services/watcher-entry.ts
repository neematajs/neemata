import { parentPort } from 'node:worker_threads'

import type { WatcherRequest, WatcherResponse } from './protocol.ts'
import { serializeError } from '../utils.ts'
import { WatcherService } from './watcher.ts'

if (!parentPort) {
  throw new Error('Neem watcher service requires a parent port')
}

const port = parentPort
let service: WatcherService | undefined

function post(message: WatcherResponse): void {
  port.postMessage(message)
}

async function handle(request: WatcherRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'start': {
        service = new WatcherService({
          configFile: request.configFile,
          outDir: request.outDir,
          runtimes: request.runtimes,
          emit: (event) => post({ type: 'event', event }),
        })
        const result = await service.start()
        post({ id: request.id, type: 'result', data: result })
        return
      }
      case 'stop':
        await service?.stop()
        service = undefined
        post({ id: request.id, type: 'result' })
        port.close()
        return
    }
  } catch (error) {
    post({ id: request.id, type: 'error', error: serializeError(error) })
  }
}

port.on('message', (message: WatcherRequest) => {
  void handle(message)
})
