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
    const manager = new NeemPluginManager({
      snapshot: createSnapshot([
        { name: 'jobs', options: { label: 'queue' } },
        { name: 'metrics', options: { label: 'metrics', failSetup: true } },
      ]),
      hooks: createNeemHostHooks(),
    })

    await expect(manager.start()).rejects.toThrow('setup failed: metrics')

    expect(manager.list()).toEqual([])
    expect(globalThis[eventsKey]).toEqual([
      expect.objectContaining({ type: 'setup', name: 'jobs' }),
      expect.objectContaining({ type: 'setup', name: 'metrics' }),
      { type: 'stop', name: 'jobs', instanceId: 0 },
    ])
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
) {
  const pluginFile = fileURLToPath(
    new URL('../fixtures/plugin-manager.plugin.js', import.meta.url),
  )

  return createRuntimeSnapshot({
    mode: 'development',
    outDir: dirname(pluginFile),
    config: {
      apps: {},
      plugins: plugins.map((plugin) => ({
        entry: async () => ({ default: {} as never }),
        options: plugin.options,
      })),
    } as NeemConfig,
    manifest: createManifest(plugins, pluginFile),
  })
}

function createManifest(
  plugins: Array<{ name: string }>,
  pluginFile: string,
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
          file: pluginFile,
          outDir: dirname(pluginFile),
        },
      ],
    })),
  }
}
