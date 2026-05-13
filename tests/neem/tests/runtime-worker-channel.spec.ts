import { once } from 'node:events'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLogger } from '@nmtjs/core'
import { describe, expect, it } from 'vitest'

import type { NeemResolvedArtifact } from '../../../packages/neem/src/public/artifact.ts'
import { createNeemArtifactRegistry } from '../../../packages/neem/src/internal/runtime/artifact-registry.ts'
import { NeemPluginWorkerManager } from '../../../packages/neem/src/internal/runtime/plugin-manager.ts'

describe('Neem plugin worker communication channel', () => {
  it('keeps plugin messages on a dedicated port outside Neem control protocol', async () => {
    const artifact = createWorkerArtifact()
    const manager = new NeemPluginWorkerManager({
      mode: 'development',
      name: 'channel',
      instanceId: 0,
      artifacts: createNeemArtifactRegistry([artifact]),
      configFile: fileURLToPath(
        new URL('../fixtures/worker.config.js', import.meta.url),
      ),
      logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
      startupTimeoutMs: 5_000,
      stopTimeoutMs: 5_000,
    })

    const worker = await manager.spawn({
      name: 'echo',
      artifact: 'entry',
      workerData: { queue: 'jobs' },
    })

    worker.port.postMessage({ type: 'ready' })
    const [readyReply] = await once(worker.port, 'message')
    expect(readyReply).toEqual({
      type: 'plugin-reply',
      data: { type: 'ready' },
    })
    expect(worker.getState()).toBe('ready')

    worker.port.postMessage({ type: 'stop' })
    const [stopReply] = await once(worker.port, 'message')
    expect(stopReply).toEqual({ type: 'plugin-reply', data: { type: 'stop' } })
    expect(worker.getState()).toBe('ready')

    const closed = once(worker.port, 'close')
    await manager.stop(worker.id)
    await closed
    expect(worker.getState()).toBe('stopped')
  })
})

function createWorkerArtifact(): NeemResolvedArtifact {
  const owner = { type: 'plugin' as const, name: 'channel', instanceId: 0 }
  const fixtureFile = fileURLToPath(
    new URL('../fixtures/runtime-channel-worker.js', import.meta.url),
  )

  return {
    id: 'entry',
    kind: 'worker',
    owner,
    file: fixtureFile,
    outDir: dirname(fixtureFile),
  }
}
