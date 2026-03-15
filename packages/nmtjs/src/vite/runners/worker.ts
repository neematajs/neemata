import type { MessagePort } from 'node:worker_threads'
import wt, { isMainThread } from 'node:worker_threads'

import type { ModuleRunnerTransport } from 'vite/module-runner'
import { noopFn } from '@nmtjs/common'
import {
  createNodeImportMeta,
  ESModulesEvaluator,
  ModuleRunner,
} from 'vite/module-runner'

export function createModuleRunner(
  vitePort: MessagePort | undefined,
  mode: 'development' | 'production' = 'development',
  timeoutMs = 5000,
): ModuleRunner {
  // TODO: bun does not support isInternalThread yet
  if (isMainThread || wt.isInternalThread)
    throw new Error('Module runner can only be created inside worker threads.')

  if (!vitePort) {
    throw new Error('Module runner requires a dedicated Vite message port.')
  }

  const transportTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000

  const transport: ModuleRunnerTransport = {
    connect({ onMessage, onDisconnection }) {
      vitePort.on('message', onMessage)
      vitePort.on('close', onDisconnection)
    },
    send(data) {
      vitePort.postMessage(data)
    },
    disconnect() {
      vitePort.close()
    },
    timeout: transportTimeout,
  }

  const runner = new ModuleRunner(
    {
      transport,
      createImportMeta: createNodeImportMeta,
      hmr:
        mode === 'development'
          ? { logger: { debug: noopFn, error: console.error } }
          : false,
    },
    new ESModulesEvaluator(),
  )

  return runner
}
