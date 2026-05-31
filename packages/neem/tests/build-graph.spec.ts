import { describe, expect, it } from 'vitest'

import { createBuildGraph } from '../src/internal/build/graph.ts'
import {
  defineConfig,
  definePlugin,
  defineRuntime,
} from '../src/public/config.ts'

const configFile = '/workspace/app/neem.config.ts'
const outDir = '/workspace/app/dist'

describe('createBuildGraph', () => {
  it('creates explicit targets for start entries, logger, plugins, workers, hosts, and artifacts', () => {
    const pluginRolldown = { name: 'plugin-rolldown' }
    const runtimeRolldown = { name: 'runtime-rolldown' }

    const graph = createBuildGraph({
      configFile,
      outDir,
      config: defineConfig({
        logger: './logger.ts',
        plugins: [
          definePlugin({
            name: '@scope/plugin one',
            entry: './plugin.ts',
            build: { rolldown: { plugins: pluginRolldown } },
            options: { fixture: true },
          }),
        ],
        runtimes: {
          api: defineRuntime({
            worker: {
              entry: './api.ts',
              build: { rolldown: { plugins: [runtimeRolldown] } },
            },
            host: { entry: './api.host.ts' },
            artifacts: [{ id: 'schema', kind: 'module', entry: './schema.ts' }],
            threads: [{ label: 'one' }],
          }),
          scheduler: defineRuntime({
            host: { entry: './scheduler.host.ts' },
            threads: 0,
            artifacts: [
              {
                id: 'scheduler-config',
                kind: 'module',
                entry: './scheduler.config.ts',
              },
            ],
          }),
        },
      }),
    })

    expect(graph.startEntry.key).toBe('runtime:start-entry')
    expect(graph.workerEntry.key).toBe('runtime:worker-entry')
    expect(graph.logger?.artifact.entry).toBe('/workspace/app/logger.ts')
    expect(graph.plugins).toHaveLength(1)
    expect(graph.plugins[0]).toMatchObject({
      key: '000-scope-plugin-one',
      name: '@scope/plugin one',
      options: { fixture: true },
    })
    expect(graph.plugins[0]?.entry?.outDir).toBe(
      '/workspace/app/dist/config/plugins/000-scope-plugin-one',
    )

    const api = graph.runtimes.find((runtime) => runtime.name === 'api')
    expect(api?.worker?.artifact.entry).toBe('/workspace/app/api.ts')
    expect(api?.worker?.artifact.rolldown?.plugins).toEqual([
      pluginRolldown,
      runtimeRolldown,
    ])
    expect(api?.host?.artifact.entry).toBe('/workspace/app/api.host.ts')
    expect(api?.artifacts.map((target) => target.artifact)).toEqual([
      { id: 'schema', kind: 'module', entry: '/workspace/app/schema.ts' },
    ])

    const scheduler = graph.runtimes.find(
      (runtime) => runtime.name === 'scheduler',
    )
    expect(scheduler?.worker).toBeUndefined()
    expect(scheduler?.host?.artifact.entry).toBe(
      '/workspace/app/scheduler.host.ts',
    )
    expect(scheduler?.artifacts.map((target) => target.artifact)).toEqual([
      {
        id: 'scheduler-config',
        kind: 'module',
        entry: '/workspace/app/scheduler.config.ts',
      },
    ])
    expect(graph.targets.map((target) => target.key)).toEqual([
      'runtime:start-entry',
      'runtime:worker-entry',
      'config:logger',
      'runtime:api:worker',
      'runtime:api:host',
      'runtime:api:artifact:000-schema',
      'runtime:scheduler:host',
      'runtime:scheduler:artifact:000-scheduler-config',
      'plugin:000-scope-plugin-one',
    ])
  })

  it('filters selected runtimes before target creation', () => {
    const graph = createBuildGraph({
      configFile,
      outDir,
      runtimes: [' scheduler '],
      config: defineConfig({
        runtimes: {
          api: defineRuntime({ worker: { entry: './api.ts' } }),
          scheduler: defineRuntime({
            host: { entry: './scheduler.host.ts' },
            threads: 0,
            artifacts: [
              {
                id: 'scheduler-config',
                kind: 'module',
                entry: './scheduler.config.ts',
              },
            ],
          }),
        },
      }),
    })

    expect(graph.runtimes.map((runtime) => runtime.name)).toEqual(['scheduler'])
    expect(graph.targets.map((target) => target.key)).toEqual([
      'runtime:start-entry',
      'runtime:worker-entry',
      'runtime:scheduler:host',
      'runtime:scheduler:artifact:000-scheduler-config',
    ])
  })

  it('fails before building when selected runtimes are unknown', () => {
    expect(() =>
      createBuildGraph({
        configFile,
        outDir,
        runtimes: ['missing'],
        config: defineConfig({
          runtimes: { api: defineRuntime({ worker: { entry: './api.ts' } }) },
        }),
      }),
    ).toThrow('Unknown Neem runtime(s): missing')
  })
})
