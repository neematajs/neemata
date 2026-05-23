import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { NeemBuildManifest } from '../../../packages/neem/src/internal/build/manifest.ts'
import type { NeemConfig } from '../../../packages/neem/src/public/config.ts'
import {
  callNeemHostHook,
  createNeemHostHooks,
} from '../../../packages/neem/src/internal/runtime/hooks.ts'
import { NeemPluginManager } from '../../../packages/neem/src/internal/runtime/plugin.ts'
import { createRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot.ts'

const eventsKey = '__neemPluginManagerEvents'

declare global {
  var __neemPluginManagerEvents: unknown[] | undefined
}

describe('NeemPluginManager', () => {
  it('runs plugin setup/stop with scoped context', async () => {
    globalThis[eventsKey] = []
    const manager = new NeemPluginManager({
      snapshot: createSnapshot([
        { name: 'jobs', options: { label: 'queue' } },
        { name: 'metrics', options: { label: 'metrics' } },
      ]),
      hooks: createNeemHostHooks(),
    })

    await manager.start()

    expect(manager.list().map((plugin) => plugin.name)).toEqual([
      'jobs',
      'metrics',
    ])
    expect(manager.list().map((plugin) => plugin.getHealth())).toEqual([
      expect.objectContaining({
        name: 'jobs',
        instanceId: 0,
        state: 'ready',
        setupComplete: true,
        workers: { count: 0, workers: [] },
      }),
      expect.objectContaining({
        name: 'metrics',
        instanceId: 1,
        state: 'ready',
        setupComplete: true,
        workers: { count: 0, workers: [] },
      }),
    ])
    expect(globalThis[eventsKey]).toEqual([
      {
        type: 'setup',
        name: 'jobs',
        instanceId: 0,
        mode: 'development',
        label: 'queue',
        artifact: 'worker',
        workers: 'function',
        hooks: 'function',
      },
      {
        type: 'setup',
        name: 'metrics',
        instanceId: 1,
        mode: 'development',
        label: 'metrics',
        artifact: 'worker',
        workers: 'function',
        hooks: 'function',
      },
    ])

    await manager.stop()

    expect(globalThis[eventsKey]).toEqual([
      expect.objectContaining({ type: 'setup', name: 'jobs' }),
      expect.objectContaining({ type: 'setup', name: 'metrics' }),
      { type: 'stop', name: 'metrics', instanceId: 1 },
      { type: 'stop', name: 'jobs', instanceId: 0 },
    ])
  })

  it('stops already-started plugins when setup fails', async () => {
    globalThis[eventsKey] = []
    const hookEvents: unknown[] = []
    const hooks = createNeemHostHooks()
    hooks.hook('plugin:fail', (event) => {
      hookEvents.push({
        type: 'plugin-fail',
        name: event.name,
        instanceId: event.instanceId,
        error: event.error?.message,
      })
    })
    const manager = new NeemPluginManager({
      snapshot: createSnapshot([
        { name: 'jobs', options: { label: 'queue' } },
        { name: 'metrics', options: { label: 'metrics', failSetup: true } },
      ]),
      hooks,
    })

    await expect(manager.start()).rejects.toThrow('setup failed: metrics')

    expect(manager.list()).toEqual([])
    expect(hookEvents).toEqual([
      {
        type: 'plugin-fail',
        name: 'metrics',
        instanceId: 1,
        error: 'setup failed: metrics',
      },
    ])
    expect(globalThis[eventsKey]).toEqual([
      expect.objectContaining({ type: 'setup', name: 'jobs' }),
      expect.objectContaining({ type: 'setup', name: 'metrics' }),
      { type: 'stop', name: 'jobs', instanceId: 0 },
    ])
  })

  it('marks plugin health failed when stop fails', async () => {
    globalThis[eventsKey] = []
    const manager = new NeemPluginManager({
      snapshot: createSnapshot([
        { name: 'jobs', options: { label: 'queue', failStop: true } },
      ]),
      hooks: createNeemHostHooks(),
    })

    await manager.start()
    const plugin = manager.list()[0]!

    await expect(manager.stop()).rejects.toThrow('stop failed: jobs')

    expect(plugin.getHealth()).toMatchObject({
      name: 'jobs',
      instanceId: 0,
      state: 'failed',
      setupComplete: false,
      lastError: expect.objectContaining({ message: 'stop failed: jobs' }),
    })
    expect(manager.list()).toEqual([])
  })

  it('marks plugin health failed when a plugin worker fails', async () => {
    globalThis[eventsKey] = []
    const workerFile = fileURLToPath(
      new URL(
        '../fixtures/runtime-fail-after-ready-worker.js',
        import.meta.url,
      ),
    )
    const failures: unknown[] = []
    const manager = new NeemPluginManager({
      snapshot: createSnapshot(
        [{ name: 'jobs', options: { label: 'queue', spawnWorker: true } }],
        { workerFile },
      ),
      hooks: createNeemHostHooks(),
      onWorkerFailure(error, plugin) {
        failures.push({
          error: error.message,
          plugin: plugin.name,
          state: plugin.getState(),
        })
      },
    })

    await manager.start()
    const plugin = manager.list()[0]!

    await waitFor(async () =>
      plugin.getHealth().state === 'failed' ? plugin.getHealth() : false,
    )

    expect(plugin.getHealth()).toMatchObject({
      name: 'jobs',
      instanceId: 0,
      state: 'failed',
      setupComplete: true,
      workers: {
        count: 1,
        workers: [
          expect.objectContaining({ state: 'failed', failureCount: 1 }),
        ],
      },
      lastError: expect.objectContaining({
        message: 'fixture plugin worker failure',
      }),
    })
    expect(failures).toEqual([
      {
        error: 'fixture plugin worker failure',
        plugin: 'jobs',
        state: 'failed',
      },
    ])

    await manager.stop().catch(() => undefined)
  })

  it('exposes observer hooks and removes plugin registrations on stop', async () => {
    globalThis[eventsKey] = []
    const hooks = createNeemHostHooks()
    const snapshot = createSnapshot([
      {
        name: 'jobs',
        options: { label: 'queue', observeHooks: true, failHook: true },
      },
    ])
    const manager = new NeemPluginManager({ snapshot, hooks })

    await manager.start()
    await manager.stop()

    expect(globalThis[eventsKey]).toEqual([
      expect.objectContaining({ type: 'setup', name: 'jobs' }),
      { type: 'hook-plugin-ready', name: 'jobs', instanceId: 0 },
      { type: 'stop', name: 'jobs', instanceId: 0 },
      { type: 'hook-plugin-stop', name: 'jobs', instanceId: 0 },
    ])

    await callNeemHostHook(hooks, snapshot.logger, 'plugin:ready', {
      mode: 'development',
      name: 'jobs',
      instanceId: 0,
    })

    expect(globalThis[eventsKey]).toHaveLength(4)
  })
})

function createSnapshot(
  plugins: Array<{ name: string; options: Record<string, unknown> }>,
  options: { workerFile?: string } = {},
) {
  const pluginFile = fileURLToPath(
    new URL('../fixtures/plugin-manager.plugin.js', import.meta.url),
  )
  const configFile = fileURLToPath(
    new URL('../fixtures/worker.config.js', import.meta.url),
  )

  return createRuntimeSnapshot({
    mode: 'development',
    outDir: dirname(pluginFile),
    configFile,
    config: {
      apps: {},
      plugins: plugins.map((plugin) => ({
        entry: async () => ({ default: {} as never }),
        options: plugin.options,
      })),
    } as NeemConfig,
    manifest: createManifest(plugins, pluginFile, options.workerFile),
  })
}

function createManifest(
  plugins: Array<{ name: string }>,
  pluginFile: string,
  workerFile = pluginFile,
): NeemBuildManifest {
  return {
    schemaVersion: 1,
    config: { file: 'neem.config.js' },
    apps: {},
    plugins: plugins.map((plugin, index) => ({
      index,
      name: plugin.name,
      entry: {
        id: 'entry',
        kind: 'module',
        owner: { type: 'plugin', name: plugin.name, instanceId: index },
        file: pluginFile,
        outDir: dirname(pluginFile),
      },
      artifacts: [
        {
          id: 'worker',
          kind: 'worker',
          owner: { type: 'plugin', name: plugin.name, instanceId: index },
          file: workerFile,
          outDir: dirname(workerFile),
        },
      ],
    })),
  }
}

async function waitFor<T>(
  fn: () => Promise<T | false> | T | false,
  timeoutMs = 5_000,
): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const result = await fn()
    if (result) return result
    await wait(25)
  }

  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
