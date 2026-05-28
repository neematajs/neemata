import type { InferNeemWorkerData } from '@nmtjs/neem'
import {
  defineConfig,
  defineRuntime,
  defineRuntimeHost,
  normalizeNeemConfig,
} from '@nmtjs/neem'
import { describe, expect, expectTypeOf, it } from 'vitest'

import app from '../fixtures/basic-app.ts'

describe('@nmtjs/neem consumer contracts', () => {
  it('keeps logger inputs typed', () => {
    const moduleSpecifier = defineConfig({
      logger: '../fixtures/logger.ts',
      runtimes: {},
    })
    const moduleUrl = defineConfig({
      logger: new URL('../fixtures/logger.ts', import.meta.url),
      runtimes: {},
    })
    const options = defineConfig({
      logger: { pinoOptions: { enabled: false } },
      runtimes: {},
    })
    const invalid = defineConfig({
      // @ts-expect-error logger functions are not declarative config
      logger: () => Promise.resolve({ default: { invalid: true } }),
      runtimes: {},
    })

    expect(moduleSpecifier.logger).toBe('../fixtures/logger.ts')
    expect(moduleUrl.logger).toBeInstanceOf(URL)
    expect(options.logger).toEqual({ pinoOptions: { enabled: false } })
    expect(Boolean(invalid)).toBe(true)
  })

  it('keeps health probe config typed', () => {
    const config = defineConfig({
      health: {
        hostname: '127.0.0.1',
        port: 3100,
        paths: { health: '/healthz', ready: '/readyz' },
      },
      runtimes: {},
    })
    const invalid = defineConfig({
      health: {
        // @ts-expect-error health probe port must be numeric
        port: '3100',
      },
      runtimes: {},
    })

    expect(config.health?.paths?.ready).toBe('/readyz')
    expect(Boolean(invalid)).toBe(true)
  })

  it('keeps runtime worker data inferred from the worker default export', () => {
    type ThreadOptions = InferNeemWorkerData<typeof app>

    expectTypeOf<ThreadOptions>().toEqualTypeOf<{
      http: { listen: { hostname: string; port: number } }
    }>()

    const runtime = defineRuntime<typeof app>({
      worker: { entry: '../fixtures/basic-app.ts' },
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    })
    const runtimeConfig = runtime

    expect(runtimeConfig.threads).toBeDefined()
    const [data] = runtimeConfig.threads as Array<ThreadOptions>
    expect(data.http.listen.port).toBe(3000)

    const stringEntryConfig = defineRuntime({
      worker: { entry: '../fixtures/basic-app.ts' },
    })
    expect(stringEntryConfig.worker.entry).toBe('../fixtures/basic-app.ts')
  })

  it('lets runtime worker entries expose definition metadata', async () => {
    expect(Object.keys(app.definition.transports)).toEqual(['http'])
  })

  it('rejects wrong runtime data at compile time', () => {
    const invalidThread: InferNeemWorkerData<typeof app> = {
      http: {
        listen: {
          hostname: '127.0.0.1',
          // @ts-expect-error port must stay numeric
          port: '3000',
        },
      },
    }

    expect(Boolean(invalidThread)).toBe(true)
  })

  it('keeps entry-specific worker data inference without an explicit worker constraint', () => {
    const invalidConfig = defineRuntime<typeof app>({
      worker: { entry: '../fixtures/basic-app.ts' },
      // @ts-expect-error port must stay numeric
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: '3000' } } }],
    })

    expect(Boolean(invalidConfig)).toBe(true)
  })

  it('allows host-owned runtime entries that are not worker entries', () => {
    const hostOwnedConfig = defineRuntime({
      worker: { entry: '../fixtures/basic-app.ts' },
      host: { entry: '../fixtures/generic-runtime-host.ts' },
    })

    expect(Boolean(hostOwnedConfig)).toBe(true)
  })

  it('types runtime hosts as per-runtime factories', () => {
    const host = defineRuntimeHost((params) => {
      expectTypeOf(params.options).toEqualTypeOf<unknown>()

      return {
        plan() {
          return { threads: [] }
        },
        start(startParams) {
          expectTypeOf(startParams).toHaveProperty('threads')
          // @ts-expect-error base runtime params are captured by factory
          void startParams.options
        },
      }
    })
    const invalidHost = defineRuntimeHost({
      // @ts-expect-error runtime hosts must be factories
      setup() {
        return undefined
      },
    })

    expect(Boolean(host)).toBe(true)
    expect(Boolean(invalidHost)).toBe(true)
  })

  it('merges tuple runtime build overrides after helper defaults', () => {
    const basePlugin = { name: 'base' }
    const overridePlugin = { name: 'override' }
    const runtime = defineRuntime({
      worker: {
        entry: '../fixtures/basic-app.ts',
        build: { rolldown: { plugins: [basePlugin] } },
      },
      artifacts: [
        { id: 'config', kind: 'module', entry: '../fixtures/basic-app.ts' },
      ],
      host: { entry: '../fixtures/generic-runtime-host.ts' },
    })

    const config = defineConfig({
      runtimes: {
        api: [
          runtime,
          {
            worker: { build: { rolldown: { plugins: [overridePlugin] } } },
            artifacts: [
              {
                id: 'extra',
                kind: 'module',
                entry: '../fixtures/basic-app.ts',
              },
            ],
          },
        ],
      },
    })
    const runtimeConfig = normalizeNeemConfig(config).runtimes.api

    expect(runtimeConfig.artifacts).toEqual([
      { id: 'config', kind: 'module', entry: '../fixtures/basic-app.ts' },
      { id: 'extra', kind: 'module', entry: '../fixtures/basic-app.ts' },
    ])
    expect(runtimeConfig.host).toMatchObject({
      entry: '../fixtures/generic-runtime-host.ts',
    })
    expect(runtimeConfig.worker.build?.rolldown?.plugins).toEqual([
      basePlugin,
      overridePlugin,
    ])
  })

  it('rejects worker-scoped runtime artifacts at compile time', () => {
    const invalidConfig = defineRuntime({
      worker: {
        entry: '../fixtures/basic-app.ts',
        // @ts-expect-error runtime artifacts must live on runtime config
        artifacts: [
          { id: 'config', kind: 'module', entry: '../fixtures/basic-app.ts' },
        ],
      },
    })

    expect(Boolean(invalidConfig)).toBe(true)
  })

  it('merges tuple runtime host overrides into host config', () => {
    const hostPlugin = { name: 'host' }
    const runtime = defineRuntime({
      worker: { entry: '../fixtures/basic-app.ts' },
      host: {
        entry: '../fixtures/generic-runtime-host.ts',
        build: { rolldown: { plugins: [hostPlugin] } },
      },
    })

    const config = defineConfig({
      runtimes: {
        api: [
          runtime,
          { host: { build: { rolldown: { external: ['host-extra'] } } } },
        ],
      },
    })
    const runtimeConfig = normalizeNeemConfig(config).runtimes.api

    expect(runtimeConfig.host).toMatchObject({
      entry: '../fixtures/generic-runtime-host.ts',
    })
    expect(runtimeConfig.host?.build?.rolldown?.plugins).toEqual([hostPlugin])
    expect(runtimeConfig.host?.build?.rolldown?.external).toEqual([
      'host-extra',
    ])
  })

  it('requires host override entry when runtime has no host', () => {
    const runtime = defineRuntime({
      worker: { entry: '../fixtures/basic-app.ts' },
    })
    const config = defineConfig({
      runtimes: { api: [runtime, { host: { build: { rolldown: {} } } }] },
    })

    expect(() => normalizeNeemConfig(config)).toThrow(
      'Runtime host override must include entry when base runtime has no host.',
    )
  })

  it('rejects old top-level tuple build overrides at compile time', () => {
    const runtime = defineRuntime({
      worker: { entry: '../fixtures/basic-app.ts' },
    })
    const invalidConfig = defineConfig({
      runtimes: {
        // @ts-expect-error tuple overrides must use explicit worker or host sections
        api: [runtime, { rolldown: { plugins: [] } }],
      },
    })

    expect(Boolean(invalidConfig)).toBe(true)
  })

  it('does not expose top-level runtime artifacts as public config', () => {
    const invalidConfig = defineRuntime({
      worker: { entry: '../fixtures/basic-app.ts' },
      // @ts-expect-error runtime artifacts must be declarative artifact entries
      artifacts: () => [],
    })

    expect(Boolean(invalidConfig)).toBe(true)
  })
})
