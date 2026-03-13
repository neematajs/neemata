import wt, {
  BroadcastChannel,
  isMainThread,
  parentPort,
  threadId,
  workerData,
} from 'node:worker_threads'

import type { HotPayload } from 'vite'
import type { ModuleRunner, ModuleRunnerTransport } from 'vite/module-runner'
import { noopFn } from '@nmtjs/common'

export interface NeemWorkerPoolMetadata {
  id: string
  kind?: string
  owner?: string
  environmentName?: string
}

export interface NeemWorkerRuntimeData {
  pool?: NeemWorkerPoolMetadata
}

export interface NeemWorkerHotContext {
  poolId: string
  environmentName: string
}

export function resolveWorkerHotContext(
  data: unknown = workerData,
): NeemWorkerHotContext | null {
  const runtimeData = data as NeemWorkerRuntimeData | null | undefined
  const pool = runtimeData?.pool

  if (!pool || typeof pool.id !== 'string' || !pool.id.trim()) {
    return null
  }

  if (
    typeof pool.environmentName !== 'string' ||
    pool.environmentName.trim().length === 0
  ) {
    return null
  }

  return { poolId: pool.id, environmentName: pool.environmentName }
}

export function createPoolBroadcastChannel(
  poolId: string,
  currentThreadId = threadId,
): BroadcastChannel {
  const normalizedPoolId = normalizePoolId(poolId)
  return new BroadcastChannel(
    `neem:vite:${normalizedPoolId}:${currentThreadId}`,
  )
}

export async function createPoolModuleRunner(
  mode: 'development' | 'production' = 'development',
  timeoutMs = 5000,
  data: unknown = workerData,
): Promise<ModuleRunner | null> {
  if (isMainThread || wt.isInternalThread) {
    throw new Error('Module runner can only be created inside worker threads.')
  }

  const hotContext = resolveWorkerHotContext(data)
  if (!hotContext) {
    return null
  }

  const viteModuleRunner = await import('vite/module-runner')
  const { createNodeImportMeta, ESModulesEvaluator, ModuleRunner } =
    viteModuleRunner

  const channel = createPoolBroadcastChannel(hotContext.poolId, threadId)

  const transportTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000

  const transport: ModuleRunnerTransport = {
    connect({ onMessage, onDisconnection }) {
      channel.onmessage = (event: MessageEvent) => {
        onMessage(event.data as HotPayload)
      }
      parentPort?.on('close', onDisconnection)
    },
    send(payload) {
      channel.postMessage(payload)
    },
    timeout: transportTimeout,
  }

  return new ModuleRunner(
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
}

function normalizePoolId(poolId: string): string {
  return poolId
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
}
