import { describe, expect, it } from 'vitest'

import type { NeemResolvedConfig } from '../../src/shared/types.ts'
import { createBuildGraph } from '../../src/internal/build/graph.ts'
import { definePlugin, defineRuntime } from '../../src/public/config.ts'

const configFile = '/workspace/app/neem.config.ts'
const outDir = '/workspace/app/dist'

describe('createBuildGraph', () => {
  it('creates start, logger, plugin, worker, host, and planner targets', () => {
    const pluginRolldown = { name: 'plugin-rolldown' }
    const runtimeRolldown = { name: 'runtime-rolldown' }

    const graph = createBuildGraph({
      configFile,
      outDir,
      config: resolvedConfig({
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
          api: runtimeDeclaration('api', {
            worker: {
              entry: './api.ts',
              build: { rolldown: { plugins: [runtimeRolldown] } },
            },
            host: { entry: './api.host.ts' },
            planner: './neem.planner.ts',
          }),
          scheduler: runtimeDeclaration('scheduler', {
            host: { entry: './scheduler.host.ts' },
            planner: './scheduler.planner.ts',
          }),
        },
      }),
    })

    expect(graph.startEntry.key).toBe('runtime:start-entry')
    expect(graph.workerEntry.key).toBe('runtime:worker-entry')
    expect(graph.hostRunnerEntry.key).toBe('runtime:host-runner-entry')
    expect(graph.logger?.artifact.entry).toBe('/workspace/app/logger.ts')
    expect(graph.plugins).toHaveLength(1)
    expect(graph.plugins[0]).toMatchObject({
      key: '000-scope-plugin-one',
      name: '@scope/plugin one',
      options: { fixture: true },
    })

    const api = graph.runtimes.find((runtime) => runtime.name === 'api')
    expect(api?.worker?.artifact.entry).toBe('/workspace/app/api/api.ts')
    expect(api?.worker?.artifact.rolldown?.plugins).toEqual([
      pluginRolldown,
      runtimeRolldown,
    ])
    expect(api?.host.artifact.entry).toBe('/workspace/app/api/api.host.ts')
    expect(api?.planner.artifact.entry).toBe(
      '/workspace/app/api/neem.planner.ts',
    )

    const scheduler = graph.runtimes.find(
      (runtime) => runtime.name === 'scheduler',
    )
    expect(scheduler?.worker).toBeUndefined()
    expect(scheduler?.host.artifact.entry).toBe(
      '/workspace/app/scheduler/scheduler.host.ts',
    )
    expect(scheduler?.planner.artifact.entry).toBe(
      '/workspace/app/scheduler/scheduler.planner.ts',
    )
    expect(graph.targets.map((target) => target.key)).toEqual([
      'runtime:start-entry',
      'runtime:worker-entry',
      'runtime:host-runner-entry',
      'config:logger',
      'runtime:api:worker',
      'runtime:api:host',
      'runtime:api:planner',
      'runtime:scheduler:host',
      'runtime:scheduler:planner',
      'plugin:000-scope-plugin-one',
    ])
  })

  it('filters selected runtimes before target creation', () => {
    const graph = createBuildGraph({
      configFile,
      outDir,
      runtimes: [' scheduler '],
      config: resolvedConfig({
        runtimes: {
          api: runtimeDeclaration('api', {
            worker: { entry: './api.ts' },
            planner: './api.planner.ts',
          }),
          scheduler: runtimeDeclaration('scheduler', {
            host: { entry: './scheduler.host.ts' },
            planner: './scheduler.planner.ts',
          }),
        },
      }),
    })

    expect(graph.runtimes.map((runtime) => runtime.name)).toEqual(['scheduler'])
    expect(graph.targets.map((target) => target.key)).toEqual([
      'runtime:start-entry',
      'runtime:worker-entry',
      'runtime:host-runner-entry',
      'runtime:scheduler:host',
      'runtime:scheduler:planner',
    ])
  })

  it('strips user rolldown topology options from graph targets', () => {
    const runtimePlugin = { name: 'runtime-plugin' }
    const graph = createBuildGraph({
      configFile,
      outDir,
      config: resolvedConfig({
        plugins: [
          definePlugin({
            name: 'plugin',
            build: {
              rolldown: {
                input: './plugin-input.ts',
                output: { entryFileNames: 'plugin-entry.js' },
                cwd: '/plugin',
                watch: { buildDelay: 100 },
                experimental: { chunkOptimization: true },
                plugins: [{ name: 'plugin-build' }],
              } as any,
            },
          }),
        ],
        runtimes: {
          api: runtimeDeclaration('api', {
            worker: {
              entry: './api.ts',
              build: {
                rolldown: {
                  output: { entryFileNames: 'worker.js' },
                  platform: 'browser',
                  plugins: [runtimePlugin],
                } as any,
              },
            },
            planner: './api.planner.ts',
          }),
        },
      }),
    })

    const api = graph.runtimes.find((runtime) => runtime.name === 'api')
    expect(api?.worker?.artifact.rolldown?.plugins).toEqual([
      { name: 'plugin-build' },
      runtimePlugin,
    ])
    expect(api?.worker?.artifact.rolldown).not.toHaveProperty('input')
    expect(api?.worker?.artifact.rolldown).not.toHaveProperty('output')
    expect(api?.worker?.artifact.rolldown).not.toHaveProperty('cwd')
    expect(api?.worker?.artifact.rolldown).not.toHaveProperty('watch')
    expect(api?.worker?.artifact.rolldown).not.toHaveProperty('experimental')
    expect(api?.worker?.artifact.rolldown).not.toHaveProperty('platform')
  })

  it('fails before building when selected runtimes are unknown', () => {
    expect(() =>
      createBuildGraph({
        configFile,
        outDir,
        runtimes: ['missing'],
        config: resolvedConfig({
          runtimes: {
            api: runtimeDeclaration('api', {
              worker: { entry: './api.ts' },
              planner: './api.planner.ts',
            }),
          },
        }),
      }),
    ).toThrow('Unknown Neem runtime(s): missing')
  })
})

function resolvedConfig(
  config: Partial<NeemResolvedConfig> & {
    runtimes: NeemResolvedConfig['runtimes']
  },
): NeemResolvedConfig {
  return {
    runtimes: config.runtimes,
    logger: config.logger,
    plugins: config.plugins,
  }
}

function runtimeDeclaration(
  name: string,
  input: Parameters<typeof defineRuntime>[0],
): NeemResolvedConfig['runtimes'][string] {
  return {
    name,
    file: `/workspace/app/${name}/neem.runtime.ts`,
    directory: `/workspace/app/${name}`,
    planner: input.planner ?? './neem.planner.ts',
    declaration: defineRuntime({ name, ...input }),
  }
}
