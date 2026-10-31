import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from 'vitest'

import type { NoParams } from '../../src/internal/rpc.ts'
import { WorkerServiceClient } from '../../src/internal/services/client.ts'
import { createTempDir } from '../support/temp.ts'

let previousRequestTimeout: string | undefined

beforeEach(() => {
  previousRequestTimeout = process.env.NEEM_WORKER_SERVICE_REQUEST_TIMEOUT_MS
})

afterEach(() => {
  if (previousRequestTimeout === undefined) {
    delete process.env.NEEM_WORKER_SERVICE_REQUEST_TIMEOUT_MS
  } else {
    process.env.NEEM_WORKER_SERVICE_REQUEST_TIMEOUT_MS = previousRequestTimeout
  }
})

type TestCommands = {
  hang: { params: NoParams; result: void }
  stop: { params: NoParams; result: void }
}

describe('WorkerServiceClient', () => {
  it('times out service requests that never receive a worker response', async () => {
    process.env.NEEM_WORKER_SERVICE_REQUEST_TIMEOUT_MS = '50'
    const entry = await createWorkerEntry(`
      import { parentPort } from 'node:worker_threads'

      parentPort.on('message', (message) => {
        if (message.type === 'stop') {
          parentPort.postMessage({ id: message.id, type: 'result' })
          parentPort.close()
        }
      })
    `)
    const client = new WorkerServiceClient<TestCommands, never>({
      entry,
      serviceName: 'test-service',
    })
    onTestFinished(() => client.stop())

    await expect(client.request('hang', {})).rejects.toThrow(
      'Neem worker service request [test-service:hang] timed out after 50ms',
    )
    await expect(client.stop()).resolves.toBeUndefined()
  })

  it('settles pending requests when the worker exits before responding', async () => {
    // Long request timeout: the rejection must come from the exit, not the timer.
    process.env.NEEM_WORKER_SERVICE_REQUEST_TIMEOUT_MS = '30000'
    const entry = await createWorkerEntry(`
      import { parentPort } from 'node:worker_threads'

      parentPort.on('message', () => {})
    `)
    const client = new WorkerServiceClient<TestCommands, never>({
      entry,
      serviceName: 'test-service',
      onFailure: () => {},
    })
    onTestFinished(() => client.stop())

    const hanging = client.request('hang', {})
    hanging.catch(() => {})
    // Kill from the parent side; vitest's thread bootstrap patches process.exit
    // inside nested workers, so the worker cannot exit itself in this suite.
    await (
      client as unknown as { worker: { terminate: () => Promise<void> } }
    ).worker.terminate()

    await expect(hanging).rejects.toThrow(
      /exited with code \[\d+\] before responding/,
    )
    await expect(client.stop()).resolves.toBeUndefined()
  })
})

async function createWorkerEntry(source: string): Promise<URL> {
  const dir = await createTempDir('neem-service-client-')
  const file = resolve(dir, 'worker.mjs')
  await writeFile(file, source)
  return pathToFileURL(file)
}
