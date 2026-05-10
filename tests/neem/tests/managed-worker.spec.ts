import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { NeemManagedWorker } from '../../../packages/neem/src/internal/runtime/managed-worker.ts'

const workerEntry = pathToFileURL(
  resolve(import.meta.dirname, '../fixtures/managed-worker.js'),
)

describe('NeemManagedWorker', () => {
  it('starts, reports ready state, and stops cleanly', async () => {
    const worker = createWorker('ready-worker', { mode: 'ready' })

    await worker.start()
    expect(worker.getState()).toBe('ready')
    expect(worker.getHealth()).toMatchObject({
      id: 'ready-worker',
      state: 'ready',
      failureCount: 0,
      restartCount: 0,
    })
    expect(worker.getHealth().readyAt).toBeTypeOf('number')

    await worker.stop()
    expect(worker.getState()).toBe('stopped')
    expect(worker.getHealth().stoppedAt).toBeTypeOf('number')
  })

  it('rejects startup when worker does not report ready before timeout', async () => {
    const worker = createWorker('timeout-worker', {
      mode: 'idle',
      startupTimeoutMs: 25,
      stopTimeoutMs: 25,
    })

    await expect(worker.start()).rejects.toThrow(
      'did not become ready within 25ms',
    )
    expect(worker.getState()).toBe('failed')
    expect(worker.getHealth()).toMatchObject({
      failureCount: 1,
      state: 'failed',
    })

    await worker.stop()
    expect(worker.getState()).toBe('stopped')
  })

  it('reports post-ready worker failure once', async () => {
    let failure: Error | undefined
    const worker = createWorker('failing-worker', {
      mode: 'fail-after-ready',
      onFailure: (error) => {
        failure = error
      },
    })

    await worker.start()
    await waitFor(() => failure)

    expect(failure?.message).toBe('managed worker fixture failure')
    expect(worker.getState()).toBe('failed')
    expect(worker.getHealth()).toMatchObject({
      failureCount: 1,
      state: 'failed',
    })

    await worker.stop()
  })
})

function createWorker(
  id: string,
  options: {
    mode: string
    startupTimeoutMs?: number
    stopTimeoutMs?: number
    onFailure?: (error: Error) => void
  },
) {
  return new NeemManagedWorker({
    id,
    name: id,
    artifactId: 'entry',
    entry: workerEntry,
    workerData: { mode: options.mode },
    startupTimeoutMs: options.startupTimeoutMs,
    stopTimeoutMs: options.stopTimeoutMs,
    onMessage(message, controller) {
      if (
        message &&
        typeof message === 'object' &&
        (message as { type?: string }).type === 'ready'
      ) {
        controller.markReady()
        return
      }

      if (
        message &&
        typeof message === 'object' &&
        (message as { type?: string }).type === 'stopped'
      ) {
        controller.markStopped()
      }
    },
    onFailure: options.onFailure,
  })
}

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const result = fn()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}
