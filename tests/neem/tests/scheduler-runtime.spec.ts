import type { NeemRuntimeHostParams } from '@nmtjs/neem'
import { createLogger } from '@nmtjs/core'
import {
  defineSchedulerRuntime,
  schedulerConfigArtifactId,
} from '@nmtjs/scheduler/neem'
import createSchedulerHost from '@nmtjs/scheduler/neem/host'
import { describe, expect, it } from 'vitest'

describe('scheduler Neem runtime helper', () => {
  it('defines scheduler as a host-only runtime with a config artifact', () => {
    const runtime = defineSchedulerRuntime({ config: './scheduler.ts' })

    expect(runtime.worker).toBeUndefined()
    expect(runtime.host?.entry).toBe('@nmtjs/scheduler/neem/host')
    expect(runtime.threads).toBe(0)
    expect(runtime.artifacts).toEqual([
      {
        id: schedulerConfigArtifactId,
        kind: 'module',
        entry: './scheduler.ts',
      },
    ])
  })

  it('requires scheduler config from the runtime artifact registry', async () => {
    await expect(
      createSchedulerHost({
        mode: 'development',
        name: 'scheduler',
        options: undefined,
        logger: testLogger,
        artifact: hostArtifact,
        hostArtifact,
        artifacts: { resolve: () => undefined, list: () => [] },
        defaultThreads: [],
      } satisfies NeemRuntimeHostParams),
    ).rejects.toThrow(
      `Scheduler runtime config artifact [${schedulerConfigArtifactId}] is missing`,
    )
  })
})

const hostArtifact: NeemRuntimeHostParams['artifact'] = {
  id: 'host',
  kind: 'module',
  owner: { type: 'runtime', name: 'scheduler' },
  file: '/workspace/app/dist/runtime/scheduler/host/index.js',
  outDir: '/workspace/app/dist/runtime/scheduler/host',
}

const testLogger: NeemRuntimeHostParams['logger'] = createLogger(
  { pinoOptions: { enabled: false } },
  'test',
)
