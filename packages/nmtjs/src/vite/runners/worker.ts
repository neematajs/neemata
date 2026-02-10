import wt, {
  BroadcastChannel,
  isMainThread,
  parentPort,
  threadId,
} from 'node:worker_threads'

import type { HotPayload } from 'vite'
import type { ModuleRunnerTransport } from 'vite/module-runner'
import { noopFn } from '@nmtjs/common'
import {
  createNodeImportMeta,
  ESModulesEvaluator,
  ModuleRunner,
} from 'vite/module-runner'

export function createBroadcastChannel(threadId: number): BroadcastChannel {
  return new BroadcastChannel(`nmtjs:vite:${threadId}`)
}

export function createModuleRunner(
  mode: 'development' | 'production' = 'development',
): ModuleRunner {
  // TODO: bun does not support isInternalThread yet
  if (isMainThread || wt.isInternalThread)
    throw new Error('Module runner can only be created inside worker threads.')

  const channel = createBroadcastChannel(threadId)

  const transport: ModuleRunnerTransport = {
    connect({ onMessage, onDisconnection }) {
      // @ts-expect-error
      channel.onmessage = (event: MessageEvent<HotPayload>) => {
        onMessage(event.data)
      }
      parentPort!.on('close', onDisconnection)
    },
    send(data) {
      channel.postMessage(data)
    },
    timeout: 5000,
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
