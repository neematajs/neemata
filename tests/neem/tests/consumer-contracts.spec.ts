import type { InferNeemThreadOptions, NeemPluginOptions } from '@nmtjs/neem'
import { createLogger } from '@nmtjs/core'
import { defineAppConfig, defineConfig, definePluginConfig } from '@nmtjs/neem'
import { describe, expect, expectTypeOf, it } from 'vitest'

import app from '../fixtures/basic-app.ts'
import jobsPlugin from '../fixtures/jobs.plugin.ts'

describe('@nmtjs/neem consumer contracts', () => {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')

  it('keeps logger instance and lazy logger entry typed', () => {
    const direct = defineConfig({ logger, apps: {} })
    const lazy = defineConfig({
      logger: () => import('../fixtures/logger.ts'),
      apps: {},
    })
    const invalid = defineConfig({
      // @ts-expect-error logger entry default must satisfy Logger
      logger: () => Promise.resolve({ default: { invalid: true } }),
      apps: {},
    })

    expect(direct.logger).toBe(logger)
    expect(typeof lazy.logger).toBe('function')
    expect(Boolean(invalid)).toBe(true)
  })

  it('keeps app thread options inferred from the app default export', () => {
    type ThreadOptions = InferNeemThreadOptions<typeof app>

    expectTypeOf<ThreadOptions>().toEqualTypeOf<{
      http: { listen: { hostname: string; port: number } }
    }>()

    const appConfig = defineAppConfig({
      entry: () => import('../fixtures/basic-app.ts'),
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    })

    const thread = appConfig.threads[0]
    expect(thread.http.listen.port).toBe(3000)
  })

  it('keeps plugin options inferred from the plugin default export', () => {
    type Options = NonNullable<NeemPluginOptions<typeof jobsPlugin>['options']>

    expectTypeOf<Options>().toEqualTypeOf<{
      queue: string
      concurrency?: number
    }>()

    const pluginConfig = definePluginConfig({
      entry: () => import('../fixtures/jobs.plugin.ts'),
      options: { queue: 'default', concurrency: 2 },
    })

    expect(pluginConfig.options?.queue).toBe('default')
  })

  it('lets app and plugin entries declare worker/module artifacts', async () => {
    const pluginArtifacts = await jobsPlugin.artifacts?.({
      mode: 'development',
      name: jobsPlugin.name,
      instanceId: 0,
      options: { queue: 'default' },
      logger,
    })

    expect(Object.keys(app.definition.transports)).toEqual(['http'])
    expect(pluginArtifacts).toMatchObject([
      { id: 'job-worker', kind: 'worker' },
      { id: 'job-renderer', kind: 'module' },
    ])
  })

  it('rejects wrong app and plugin option types at compile time', () => {
    const invalidThread: InferNeemThreadOptions<typeof app> = {
      http: {
        listen: {
          hostname: '127.0.0.1',
          // @ts-expect-error port must stay numeric
          port: '3000',
        },
      },
    }

    const invalidPlugin = definePluginConfig({
      entry: () => import('../fixtures/jobs.plugin.ts'),
      options: {
        queue: 'default',
        // @ts-expect-error concurrency must stay numeric
        concurrency: '2',
      },
    })

    expect(Boolean(invalidThread)).toBe(true)
    expect(Boolean(invalidPlugin)).toBe(true)
  })

  it('keeps entry-specific thread inference without an explicit app constraint', () => {
    const invalidConfig = defineAppConfig({
      entry: () => import('../fixtures/basic-app.ts'),
      // @ts-expect-error port must stay numeric
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: '3000' } } }],
    })

    expect(Boolean(invalidConfig)).toBe(true)
  })

  it('rejects app entries whose default export does not satisfy NeemApp', () => {
    const invalidConfig = defineAppConfig({
      // @ts-expect-error entry default must satisfy NeemApp
      entry: () => Promise.resolve({ default: { kind: 'invalid' } }),
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    })

    expect(Boolean(invalidConfig)).toBe(true)
  })

  it('rejects plugin entries whose default export does not satisfy NeemPlugin', () => {
    const invalidConfig = definePluginConfig({
      // @ts-expect-error entry default must satisfy NeemPlugin
      entry: () => Promise.resolve({ default: { invalid: true } }),
      options: { queue: 'default' },
    })

    expect(Boolean(invalidConfig)).toBe(true)
  })
})
