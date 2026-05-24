import type { InferNeemWorkerData } from '@nmtjs/neem'
import { createLogger } from '@nmtjs/core'
import { defineConfig, defineRuntimeConfig } from '@nmtjs/neem'
import { describe, expect, expectTypeOf, it } from 'vitest'

import app from '../fixtures/basic-app.ts'

describe('@nmtjs/neem consumer contracts', () => {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')

  it('keeps logger inputs typed', () => {
    const direct = defineConfig({ logger, runtimes: {} })
    const lazy = defineConfig({
      logger: () => import('../fixtures/logger.ts'),
      runtimes: {},
    })
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
      // @ts-expect-error logger entry default must satisfy Logger
      logger: () => Promise.resolve({ default: { invalid: true } }),
      runtimes: {},
    })

    expect(direct.logger).toBe(logger)
    expect(typeof lazy.logger).toBe('function')
    expect(moduleSpecifier.logger).toBe('../fixtures/logger.ts')
    expect(moduleUrl.logger).toBeInstanceOf(URL)
    expect(options.logger).toEqual({ pinoOptions: { enabled: false } })
    expect(Boolean(invalid)).toBe(true)
  })

  it('keeps runtime worker data inferred from the worker default export', () => {
    type ThreadOptions = InferNeemWorkerData<typeof app>

    expectTypeOf<ThreadOptions>().toEqualTypeOf<{
      http: { listen: { hostname: string; port: number } }
    }>()

    const runtimeConfig = defineRuntimeConfig({
      entry: () => import('../fixtures/basic-app.ts'),
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    })

    expect(runtimeConfig.threads).toBeDefined()
    const [data] = runtimeConfig.threads as Array<ThreadOptions>
    expect(data.http.listen.port).toBe(3000)
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
    const invalidConfig = defineRuntimeConfig({
      entry: () => import('../fixtures/basic-app.ts'),
      // @ts-expect-error port must stay numeric
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: '3000' } } }],
    })

    expect(Boolean(invalidConfig)).toBe(true)
  })

  it('allows host-owned runtime entries that are not worker entries', () => {
    const hostOwnedConfig = defineRuntimeConfig({
      entry: () => Promise.resolve({ default: { hostOwned: true } }),
      host: () => Promise.resolve({ default: {} }),
    })

    expect(Boolean(hostOwnedConfig)).toBe(true)
  })
})
