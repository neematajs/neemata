import { once } from 'node:events'
import path from 'node:path'
import { MessageChannel } from 'node:worker_threads'

import { createLogger } from '@nmtjs/core'
import { describe, expect, it } from 'vitest'

import type { ErrorPolicy } from '../src/runtime/server/error-policy.ts'
import { WorkerType } from '../src/runtime/enums.ts'
import { ManagedWorker } from '../src/runtime/server/managed-worker.ts'

const fixturePath = path.resolve(
  import.meta.dirname,
  './fixtures/managed-worker-fixture.mjs',
)

class ManagedWorkerTestDouble extends ManagedWorker {
  markReadyForRun() {
    this.state = 'ready'
    const { port1, port2 } = new MessageChannel()
    this.port = port1
    port2.close()
  }

  triggerRuntimeError(error: Error) {
    this.handleError(error)
  }

  getPendingTaskCount() {
    return this.pendingTaskIds.size
  }
}

describe('ManagedWorker', () => {
  it('settles pending run calls and clears tracking on runtime error', async () => {
    const errorPolicy: ErrorPolicy = {
      onStartupError: () => ({ type: 'ignore' }),
      onWorkerError: () => ({ type: 'ignore' }),
      getRestartDelay: () => 0,
      allowDegradedMode: true,
    }

    const worker = new ManagedWorkerTestDouble(
      {
        id: 'test-worker-1',
        name: 'test-worker',
        index: 0,
        workerType: WorkerType.Job,
        path: '/dev/null',
      },
      errorPolicy,
      createLogger({ pinoOptions: { enabled: false } }, 'test'),
    )

    worker.markReadyForRun()

    const pending = worker.run({
      jobId: 'job-1',
      jobName: 'job-name',
      data: { value: 1 },
    })

    worker.triggerRuntimeError(new Error('runtime failure'))

    await expect(pending).rejects.toThrow('runtime failure')

    expect(worker.getPendingTaskCount()).toBe(0)
  })

  it('provisions a dedicated vite port for worker registration', async () => {
    const errorPolicy: ErrorPolicy = {
      onStartupError: () => ({ type: 'ignore' }),
      onWorkerError: () => ({ type: 'ignore' }),
      getRestartDelay: () => 0,
      allowDegradedMode: true,
    }

    let registration:
      | {
          worker: import('node:worker_threads').Worker
          vitePort?: import('node:worker_threads').MessagePort
        }
      | undefined

    const worker = new ManagedWorker(
      {
        id: 'test-worker-2',
        name: 'test-worker',
        index: 1,
        workerType: WorkerType.Application,
        path: fixturePath,
        onWorker(value) {
          registration = value
        },
      },
      errorPolicy,
      createLogger({ pinoOptions: { enabled: false } }, 'test'),
    )

    await worker.start()

    expect(registration?.worker).toBeTruthy()
    expect(registration?.vitePort).toBeTruthy()

    const messagePromise = once(registration!.vitePort!, 'message')
    registration!.vitePort!.postMessage({ event: 'ping', data: 'pong' })

    const [message] = await messagePromise
    expect(message).toEqual({ event: 'ack', data: 'pong' })

    const closePromise = once(registration!.vitePort!, 'close')
    await worker.stop()
    await closePromise
  })
})
