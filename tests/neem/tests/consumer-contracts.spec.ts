import type { InferNeemWorkerData } from '@nmtjs/neem'
import { defineConfig, defineRuntime } from '@nmtjs/neem'
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

    const runtimeConfig = defineRuntime<typeof app>({
      entry: '../fixtures/basic-app.ts',
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    })

    expect(runtimeConfig.threads).toBeDefined()
    const [data] = runtimeConfig.threads as Array<ThreadOptions>
    expect(data.http.listen.port).toBe(3000)

    const stringEntryConfig = defineRuntime({
      entry: '../fixtures/basic-app.ts',
    })
    expect(stringEntryConfig.entry).toBe('../fixtures/basic-app.ts')
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
      entry: '../fixtures/basic-app.ts',
      // @ts-expect-error port must stay numeric
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: '3000' } } }],
    })

    expect(Boolean(invalidConfig)).toBe(true)
  })

  it('allows host-owned runtime entries that are not worker entries', () => {
    const hostOwnedConfig = defineRuntime({
      entry: '../fixtures/basic-app.ts',
      host: '../fixtures/generic-runtime-host.ts',
    })

    expect(Boolean(hostOwnedConfig)).toBe(true)
  })

  it('does not expose runtime artifacts as public config', () => {
    const invalidConfig = defineRuntime({
      entry: '../fixtures/basic-app.ts',
      // @ts-expect-error runtime artifacts are helper-owned build metadata
      artifacts: () => [],
    })

    expect(Boolean(invalidConfig)).toBe(true)
  })
})
