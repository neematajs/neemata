import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WorkerServiceClient } from '../../src/internal/services/client.ts'

const tempDirs: string[] = []
let previousRequestTimeout: string | undefined

beforeEach(() => {
  previousRequestTimeout = process.env.NEEM_WORKER_SERVICE_REQUEST_TIMEOUT_MS
})

afterEach(async () => {
  if (previousRequestTimeout === undefined) {
    delete process.env.NEEM_WORKER_SERVICE_REQUEST_TIMEOUT_MS
  } else {
    process.env.NEEM_WORKER_SERVICE_REQUEST_TIMEOUT_MS = previousRequestTimeout
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

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
    const client = new WorkerServiceClient<never>({
      entry,
      serviceName: 'test-service',
    })

    await expect(client.request({ type: 'hang' })).rejects.toThrow(
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
    const client = new WorkerServiceClient<never>({
      entry,
      serviceName: 'test-service',
      onFailure: () => {},
    })

    const hanging = client.request({ type: 'hang' })
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
  const dir = await mkdtemp(resolve(tmpdir(), 'neem-service-client-'))
  tempDirs.push(dir)
  const file = resolve(dir, 'worker.mjs')
  await writeFile(file, source)
  return pathToFileURL(file)
}
