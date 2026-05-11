import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { NeemBuildManifest } from '../../../packages/neem/src/internal/build/manifest.ts'
import type { NeemRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot.ts'
import type { NeemConfig } from '../../../packages/neem/src/public/config.ts'
import { NeemApplicationServer } from '../../../packages/neem/src/internal/runtime/application-server.ts'
import { createRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot.ts'

describe('NeemApplicationServer', () => {
  it('exposes snapshot metadata and marks start/stop state', async () => {
    const server = new TestApplicationServer({
      snapshot: createSnapshot('api'),
    })

    expect(server.getSnapshot()).toMatchObject({
      mode: 'production',
      outDir: '/tmp/neem-out',
      appNames: ['api'],
      pluginNames: ['jobs'],
      artifactCount: 2,
      state: 'idle',
      revision: 0,
    })

    await server.start()
    expect(server.getState()).toBe('running')

    await server.stop()
    expect(server.getState()).toBe('stopped')
  })

  it('reloads with a new snapshot', async () => {
    const events: string[] = []
    const server = new TestApplicationServer({
      snapshot: createSnapshot('api'),
      events,
    })

    await server.start()
    await server.reload(createSnapshot('admin'))

    expect(server.getSnapshot()).toMatchObject({
      state: 'running',
      appNames: ['admin'],
    })
    expect(events).toEqual([
      'start:/tmp/neem-out',
      'stop:/tmp/neem-out',
      'start:/tmp/neem-out',
    ])
  })

  it('marks failed state when start fails', async () => {
    const error = new Error('fixture start failure')
    const server = new TestApplicationServer({
      snapshot: createSnapshot('api'),
      startError: error,
    })

    await expect(server.start()).rejects.toThrow(error)
    expect(server.getSnapshot()).toMatchObject({
      state: 'failed',
      lastError: error,
    })
  })

  it('serializes operations', async () => {
    const events: string[] = []
    const server = new TestApplicationServer({
      snapshot: createSnapshot('api'),
      events,
      delayMs: 10,
    })

    await Promise.all([server.start(), server.reload(createSnapshot('admin'))])

    expect(events).toEqual([
      'start:/tmp/neem-out',
      'stop:/tmp/neem-out',
      'start:/tmp/neem-out',
    ])
  })
})

class TestApplicationServer extends NeemApplicationServer {
  private readonly events: string[]
  private readonly startError: Error | undefined
  private readonly delayMs: number

  constructor(options: {
    snapshot: NeemRuntimeSnapshot
    events?: string[]
    startError?: Error
    delayMs?: number
  }) {
    super({ snapshot: options.snapshot })
    this.events = options.events ?? []
    this.startError = options.startError
    this.delayMs = options.delayMs ?? 0
  }

  protected override async startRuntime(
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    if (this.delayMs) await wait(this.delayMs)
    if (this.startError) throw this.startError
    this.events.push(`start:${snapshot.outDir}`)
  }

  protected override async stopRuntime(
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    this.events.push(`stop:${snapshot.outDir}`)
  }
}

function createSnapshot(appName: string): NeemRuntimeSnapshot {
  const pluginFile = fileURLToPath(
    new URL('../fixtures/plugin-manager.plugin.js', import.meta.url),
  )

  return createRuntimeSnapshot({
    mode: 'production',
    outDir: '/tmp/neem-out',
    config: {
      apps: {},
      plugins: [
        {
          entry: async () => ({ default: {} as never }),
          options: { label: 'app-server' },
        },
      ],
    } as NeemConfig,
    manifest: createManifest(appName, pluginFile),
  })
}

function createManifest(
  appName: string,
  pluginFile: string,
): NeemBuildManifest {
  return {
    schemaVersion: 1,
    config: { file: 'config/entry/neem.config.js' },
    apps: {
      [appName]: {
        name: appName,
        entry: {
          id: 'entry',
          kind: 'module',
          owner: { type: 'app', name: appName },
          file: `apps/${appName}/entry/${appName}.js`,
          outDir: `apps/${appName}/entry`,
        },
      },
    },
    plugins: [
      {
        index: 0,
        name: 'jobs',
        entry: {
          id: 'entry',
          kind: 'module',
          owner: { type: 'plugin', name: 'jobs', instanceId: 0 },
          file: pluginFile,
          outDir: dirname(pluginFile),
        },
        artifacts: [],
      },
    ],
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
