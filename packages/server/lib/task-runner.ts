import { randomUUID } from 'node:crypto'
import type { MessagePort } from 'node:worker_threads'
import { type BaseTaskExecutor, onAbort } from '@nmtjs/application'
import { WorkerMessageType, createBroadcastChannel } from './common.ts'

export class WorkerThreadsTaskRunner implements BaseTaskExecutor {
  constructor(private readonly port: MessagePort) {}

  execute(signal: AbortSignal, name: string, ...args: any[]) {
    if (!name) throw new Error('Task name is required')

    const id = randomUUID()

    // TODO: performance is 15-17% worse than passing events via
    // the main thread manually, instead of using broadcast channel.
    // Mini bench (node v20.9.0, M1 mbp): 21-22k vs 25-26k per seconds.
    // Need to investigate this further and see if there's any way to improve it.
    const bc = createBroadcastChannel(id)

    const result = new Promise((resolve, reject) => {
      onAbort(signal, reject)
      bc.once(WorkerMessageType.ExecuteResult, (payload) => {
        const { error, result } = payload
        if (error) reject(error)
        else resolve(result)
        bc.close()
      })
    })

    this.port.postMessage({
      type: WorkerMessageType.ExecuteInvoke,
      payload: { id, name, args },
    })

    onAbort(signal, () =>
      bc.postMessage({ type: WorkerMessageType.ExecuteAbort }),
    )

    return result
  }
}
