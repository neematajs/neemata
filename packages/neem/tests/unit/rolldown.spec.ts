import type { RolldownOptions, RolldownPlugin } from 'rolldown'
import { describe, expect, it } from 'vitest'

import {
  mergeRolldownOptions,
  mergeUserRolldownOptions,
} from '../../src/shared/rolldown.ts'

describe('mergeRolldownOptions', () => {
  it('applies Neem hierarchy from highest precedence through defaults', () => {
    const rootPlugin = plugin('root-config')
    const metricsPlugin = plugin('metrics-plugin')
    const runtimePlugin = plugin('runtime')
    const finalizationPlugin = plugin('neem-finalization')

    const rootConfig = {
      cwd: '/workspace/root',
      platform: 'node',
      resolve: {
        alias: { '@root': './root.ts', shared: './root-shared.ts' },
        extensions: ['.js'],
      },
      transform: { define: { ROOT_FLAG: 'true', SHARED_FLAG: '"root"' } },
      plugins: [rootPlugin],
    } satisfies RolldownOptions
    const pluginLayer = {
      platform: 'browser',
      resolve: {
        alias: { '@metrics': './metrics.ts', shared: './metrics-shared.ts' },
        extensions: ['.ts', '.tsx'],
      },
      transform: { define: { METRICS_FLAG: 'true', SHARED_FLAG: '"metrics"' } },
      plugins: [metricsPlugin],
    } satisfies RolldownOptions
    const runtime = {
      platform: 'neutral',
      resolve: {
        alias: { '@runtime': './runtime.ts', shared: './runtime-shared.ts' },
      },
      transform: { define: { RUNTIME_FLAG: 'true', SHARED_FLAG: '"runtime"' } },
      plugins: [runtimePlugin],
    } satisfies RolldownOptions
    const internalFinalization = {
      cwd: '/workspace/final',
      transform: { define: { FINAL_FLAG: 'true' } },
      plugins: [finalizationPlugin],
    } satisfies RolldownOptions

    const merged = mergeRolldownOptions(
      internalFinalization,
      runtime,
      pluginLayer,
      rootConfig,
    )

    expect(merged).toMatchObject({
      cwd: '/workspace/final',
      platform: 'neutral',
      resolve: {
        alias: {
          '@root': './root.ts',
          '@metrics': './metrics.ts',
          '@runtime': './runtime.ts',
          shared: './runtime-shared.ts',
        },
        extensions: ['.ts', '.tsx', '.js'],
      },
      transform: {
        define: {
          ROOT_FLAG: 'true',
          METRICS_FLAG: 'true',
          RUNTIME_FLAG: 'true',
          FINAL_FLAG: 'true',
          SHARED_FLAG: '"runtime"',
        },
      },
    })
    expect(merged.plugins).toEqual([
      rootPlugin,
      metricsPlugin,
      runtimePlugin,
      finalizationPlugin,
    ])
  })

  it('applies defu defaults to input and output', () => {
    const rootConfig = {
      input: 'root.ts',
      output: { format: 'esm', entryFileNames: 'root.js' },
    } satisfies RolldownOptions
    const pluginLayer = {
      input: 'plugin.ts',
      output: { assetFileNames: 'plugin-[hash][extname]' },
    } satisfies RolldownOptions
    const runtime = {
      input: 'runtime.ts',
      output: { chunkFileNames: 'runtime-[hash].js' },
    } satisfies RolldownOptions
    const internalFinalization = {
      input: 'neem-entry.ts',
      output: { sourcemap: true, entryFileNames: 'final.js' },
    } satisfies RolldownOptions

    const merged = mergeRolldownOptions(
      internalFinalization,
      runtime,
      pluginLayer,
      rootConfig,
    )

    expect(merged.input).toBe('neem-entry.ts')
    expect(merged.output).toEqual({
      sourcemap: true,
      entryFileNames: 'final.js',
      chunkFileNames: 'runtime-[hash].js',
      assetFileNames: 'plugin-[hash][extname]',
      format: 'esm',
    })
  })
})

describe('mergeUserRolldownOptions', () => {
  it('drops input and output from every layer', () => {
    const merged = mergeUserRolldownOptions(
      {
        cwd: '/workspace/user',
        input: 'user.ts',
        output: { entryFileNames: 'user.js' },
        transform: { define: { USER_FLAG: 'true' } },
      },
      {
        cwd: '/workspace/default',
        input: 'default.ts',
        output: { entryFileNames: 'default.js' },
        transform: { define: { DEFAULT_FLAG: 'true' } },
      },
    )

    expect(merged).not.toHaveProperty('cwd')
    expect(merged).not.toHaveProperty('input')
    expect(merged).not.toHaveProperty('output')
    expect(merged.transform?.define).toEqual({
      USER_FLAG: 'true',
      DEFAULT_FLAG: 'true',
    })
  })

  it('applies user hierarchy with runtime overriding plugins and root config', () => {
    const runtimePlugin = plugin('runtime')
    const metricsPlugin = plugin('metrics-plugin')
    const rootPlugin = plugin('root-config')

    const runtime = {
      cwd: '/workspace/runtime',
      platform: 'browser',
      resolve: {
        alias: { '@runtime': './runtime.ts', shared: './runtime-shared.ts' },
      },
      transform: { define: { RUNTIME_FLAG: 'true', SHARED_FLAG: '"runtime"' } },
      plugins: [runtimePlugin],
    } satisfies RolldownOptions
    const pluginLayer = {
      cwd: '/workspace/plugin',
      platform: 'node',
      resolve: {
        alias: { '@metrics': './metrics.ts', shared: './metrics-shared.ts' },
        extensions: ['.ts'],
      },
      transform: { define: { METRICS_FLAG: 'true', SHARED_FLAG: '"metrics"' } },
      plugins: [metricsPlugin],
    } satisfies RolldownOptions
    const rootConfig = {
      resolve: { alias: { '@root': './root.ts' } },
      transform: { define: { ROOT_FLAG: 'true' } },
      plugins: [rootPlugin],
    } satisfies RolldownOptions

    const merged = mergeUserRolldownOptions(runtime, pluginLayer, rootConfig)

    expect(merged).toMatchObject({
      platform: 'browser',
      resolve: {
        alias: {
          '@runtime': './runtime.ts',
          '@metrics': './metrics.ts',
          '@root': './root.ts',
          shared: './runtime-shared.ts',
        },
        extensions: ['.ts'],
      },
      transform: {
        define: {
          RUNTIME_FLAG: 'true',
          METRICS_FLAG: 'true',
          ROOT_FLAG: 'true',
          SHARED_FLAG: '"runtime"',
        },
      },
    })
    expect(merged).not.toHaveProperty('cwd')
    expect(merged).not.toHaveProperty('input')
    expect(merged).not.toHaveProperty('output')
    expect(merged.plugins).toEqual([rootPlugin, metricsPlugin, runtimePlugin])
  })
})

function plugin(name: string): RolldownPlugin {
  return { name }
}
