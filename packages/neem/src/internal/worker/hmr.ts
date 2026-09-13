import type { MessagePort } from 'node:worker_threads'

import type {
  NeemRuntime,
  NeemRuntimeHmrAdapter,
  NeemRuntimeWorker,
  NeemRuntimeWorkerContext,
} from '../../shared/types.ts'
import type {
  ParentMessage,
  RuntimeWorkerData,
  WorkerHmrResult,
  WorkerMessage,
} from './protocol.ts'
import { isNeemRuntimeWorker } from '../../public/worker.ts'
import { normalizeError } from '../utils.ts'

type RuntimeWorker = NeemRuntimeWorker<unknown, unknown>
type RuntimeHmrAdapter = NeemRuntimeHmrAdapter<unknown, unknown>

type NeemHmrGlobal = typeof globalThis & {
  __neem_hmr_client_id__?: string
  __neem_hmr__?: {
    apply: (
      update: Extract<ParentMessage, { type: 'hmr-update' }>['update'],
      url?: string,
    ) => Promise<WorkerHmrResult>
  }
  __neem_accept_worker__?: (worker: unknown) => Promise<void>
}

let port: MessagePort | undefined
let runtime: NeemRuntime | undefined
let currentWorker: RuntimeWorker | undefined
let adapter: RuntimeHmrAdapter | undefined

export function initializeWorkerHmr(options: {
  port: MessagePort
  workerData: RuntimeWorkerData
}): void {
  port = options.port
  const hmrGlobal = globalThis as NeemHmrGlobal
  // Rolldown reads the id while evaluating the runtime artifact, so install it
  // before the worker module is imported by the shared bootstrap.
  hmrGlobal.__neem_hmr_client_id__ = options.workerData.hmrClientId
  hmrGlobal.__neem_accept_worker__ = acceptWorker
  options.port.on('message', (message: ParentMessage) => {
    if (message?.type === 'hmr-update') void applyHmrUpdate(message)
  })
}

export async function createHmrRuntime(
  worker: RuntimeWorker,
  context: NeemRuntimeWorkerContext<unknown, unknown>,
): Promise<NeemRuntime> {
  currentWorker = worker
  adapter = worker.hmr ? await worker.hmr() : undefined
  runtime = await (adapter
    ? adapter.createRuntime(worker, context)
    : worker.createRuntime(context))
  return runtime
}

async function acceptWorker(next: unknown): Promise<void> {
  if (!isNeemRuntimeWorker(next)) {
    throw new Error('HMR worker default export is not a marked runtime worker')
  }
  if (!runtime || !currentWorker || !adapter) {
    throw new Error('Runtime does not provide an experimental HMR adapter')
  }
  const nextAdapter = next.hmr ? await next.hmr() : undefined
  if (!nextAdapter) {
    throw new Error(
      'Updated worker does not provide an experimental HMR adapter',
    )
  }
  const result = await nextAdapter.apply(runtime, currentWorker, next)
  if (!result.accepted) {
    throw new Error(result.reason ?? 'Runtime rejected the HMR update')
  }
  adapter = nextAdapter
  currentWorker = next
}

async function applyHmrUpdate(
  message: Extract<ParentMessage, { type: 'hmr-update' }>,
): Promise<void> {
  const workerPort = port
  if (!workerPort) return

  const client = (globalThis as NeemHmrGlobal).__neem_hmr__
  if (!client) {
    postMessage(workerPort, {
      id: message.id,
      type: 'result',
      data: {
        accepted: false,
        delivered: false,
        reason: 'Worker artifact was not built with Rolldown DevEngine',
      },
    })
    return
  }

  try {
    const result = await client.apply(message.update, message.url)
    postMessage(workerPort, { id: message.id, type: 'result', data: result })
  } catch (error) {
    postMessage(workerPort, {
      id: message.id,
      type: 'result',
      data: {
        accepted: false,
        delivered: false,
        reason: normalizeError(error).message,
      },
    })
  }
}

function postMessage(workerPort: MessagePort, message: WorkerMessage): void {
  workerPort.postMessage(message)
}
