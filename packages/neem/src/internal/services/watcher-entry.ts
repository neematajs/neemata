import { existsSync, unlinkSync } from 'node:fs'
import { parentPort } from 'node:worker_threads'

import type { WatcherCommands, WatcherEvent } from './protocol.ts'
import { serveRpc } from '../rpc.ts'
import { WATCHER_SERIAL_COMMANDS } from './protocol.ts'
import { WatcherService } from './watcher.ts'

let service: WatcherService | undefined

const server = serveRpc<WatcherCommands, WatcherEvent>(
  parentPort,
  'Neem watcher service',
  {
    start: (params) => {
      service = new WatcherService({
        ...params,
        emit: (event) => server.post(event),
      })
      return service.start()
    },
    'patch-client-started': async ({ runtimeName, clientId }) => {
      await service?.addPatchClient(runtimeName, clientId)
    },
    'patch-client-stopped': async ({ runtimeName, clientId }) => {
      await service?.removePatchClient(runtimeName, clientId)
    },
    'patch-delivered': async ({ runtimeName, filenames }) => {
      await service?.notifyPatchDelivered(runtimeName, filenames)
    },
    'ensure-worker-output': ({ runtimeName }) =>
      service?.ensureWorkerOutput(runtimeName),
    stop: async (_params, { exitAfterReply }) => {
      await service?.stop()
      service = undefined
      exitAfterReply(0)
    },
  },
  { serial: WATCHER_SERIAL_COMMANDS },
)

// Test-only: e2e tests crash the watcher once by creating this file, to cover
// the dev session restarting it.
const crashFile =
  process.env.NEEM_TEST_PROBE === '1'
    ? process.env.NEEM_TEST_WATCHER_CRASH_FILE
    : undefined
if (crashFile) {
  setInterval(() => {
    if (!existsSync(crashFile)) return
    try {
      unlinkSync(crashFile)
    } catch {
      return
    }
    process.exit(1)
  }, 25).unref()
}
