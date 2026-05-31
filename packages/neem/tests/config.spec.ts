import { describe, expect, it } from 'vitest'

import type { NeemArtifact } from '../src/public/artifact.ts'
import { mergeRolldownOptions } from '../src/internal/build/rolldown-options.ts'
import {
  defineConfig,
  definePlugin,
  defineRuntime,
  normalizeNeemConfig,
  normalizeNeemRuntimeConfig,
} from '../src/public/config.ts'

describe('Neem config normalization', () => {
  it('normalizes tuple overrides for worker, host, and runtime artifacts', () => {
    const baseArtifact: NeemArtifact = {
      id: 'schema',
      kind: 'module',
      entry: './schema.ts',
    }
    const overrideArtifact: NeemArtifact = {
      id: 'codec',
      kind: 'module',
      entry: './codec.ts',
    }
    const basePlugin = { name: 'base-plugin' }
    const overridePlugin = { name: 'override-plugin' }

    const runtime = normalizeNeemRuntimeConfig([
      defineRuntime({
        worker: {
          entry: './api.ts',
          build: {
            rolldown: {
              plugins: [basePlugin],
              output: { entryFileNames: 'api.js', sourcemap: true },
            },
          },
        },
        host: {
          entry: './host.ts',
          build: { rolldown: { output: { chunkFileNames: 'host-[hash].js' } } },
        },
        artifacts: [baseArtifact],
        threads: 2,
        options: { queue: 'main' },
      }),
      {
        worker: {
          build: {
            rolldown: {
              plugins: overridePlugin,
              output: { sourcemap: false, chunkFileNames: 'api-[hash].js' },
            },
          },
        },
        host: {
          build: { rolldown: { output: { entryFileNames: 'host.js' } } },
        },
        artifacts: [overrideArtifact],
      },
    ])

    expect(runtime.worker?.build?.rolldown?.plugins).toEqual([
      basePlugin,
      overridePlugin,
    ])
    expect(runtime.worker?.build?.rolldown?.output).toMatchObject({
      entryFileNames: 'api.js',
      chunkFileNames: 'api-[hash].js',
      sourcemap: false,
    })
    expect(runtime.host?.build?.rolldown?.output).toMatchObject({
      chunkFileNames: 'host-[hash].js',
      entryFileNames: 'host.js',
    })
    expect(runtime.artifacts).toEqual([baseArtifact, overrideArtifact])
    expect(runtime.threads).toBe(2)
    expect(runtime.options).toEqual({ queue: 'main' })
  })

  it('requires a host override entry when base runtime has no host', () => {
    expect(() =>
      normalizeNeemRuntimeConfig([
        defineRuntime({ worker: { entry: './api.ts' } }),
        { host: { build: { rolldown: { output: { sourcemap: true } } } } },
      ]),
    ).toThrow('Runtime host override must include entry')
  })

  it('normalizes all runtime entries and preserves plugin declarations', () => {
    const config = normalizeNeemConfig(
      defineConfig({
        plugins: [
          definePlugin({
            name: 'fixture',
            entry: './plugin.ts',
            options: { enabled: true },
          }),
        ],
        runtimes: {
          api: [
            defineRuntime({ worker: { entry: './api.ts' } }),
            { artifacts: [{ id: 'schema', kind: 'module', entry: './s.ts' }] },
          ],
          scheduler: defineRuntime({
            host: { entry: './scheduler.host.ts' },
            threads: 0,
          }),
        },
      }),
    )

    expect(config.runtimes.api.artifacts).toEqual([
      { id: 'schema', kind: 'module', entry: './s.ts' },
    ])
    expect(config.runtimes.scheduler.worker).toBeUndefined()
    expect(config.plugins?.[0]?.name).toBe('fixture')
  })
})

describe('mergeRolldownOptions', () => {
  it('merges plugins in layer order and output objects by override order', () => {
    const firstPlugin = { name: 'first' }
    const secondPlugin = { name: 'second' }

    const merged = mergeRolldownOptions(
      {
        plugins: firstPlugin,
        output: { entryFileNames: 'first.js', sourcemap: true },
      },
      {
        plugins: [secondPlugin],
        output: { sourcemap: false, chunkFileNames: '[name].js' },
      },
    )

    expect(merged?.plugins).toEqual([firstPlugin, secondPlugin])
    expect(merged?.output).toMatchObject({
      entryFileNames: 'first.js',
      chunkFileNames: '[name].js',
      sourcemap: false,
    })
  })

  it('rejects Rolldown output arrays', () => {
    expect(() =>
      mergeRolldownOptions({ output: [{ entryFileNames: 'a.js' }] }),
    ).toThrow('Neem Rolldown output arrays are not supported')
  })
})
