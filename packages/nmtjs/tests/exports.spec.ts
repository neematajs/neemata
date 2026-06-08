import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('nmtjs umbrella exports', () => {
  it('exposes the curated named export surface only', async () => {
    const mod = await import('../src/index.ts')

    expect(mod).toEqual(
      expect.objectContaining({
        app: expect.any(Function),
        host: expect.any(Function),
        plugin: expect.any(Function),
        rootRouter: expect.any(Function),
        router: expect.any(Function),
        contractRouter: expect.any(Function),
        procedure: expect.any(Function),
        contractProcedure: expect.any(Function),
        middleware: expect.any(Function),
        meta: expect.any(Function),
        guard: expect.any(Function),
        filter: expect.any(Function),
        hook: expect.any(Function),
        value: expect.any(Function),
        lazy: expect.any(Function),
        factory: expect.any(Function),
        transport: expect.any(Function),
        job: expect.any(Function),
        step: expect.any(Function),
        jobRouter: expect.any(Function),
        jobOperation: expect.any(Function),
        jobsPlugin: expect.any(Function),
        pubsubPlugin: expect.any(Function),
        eventingPlugin: expect.any(Function),
        eventConsumer: expect.any(Function),
        eventConsumers: expect.any(Function),
        eventSubscription: expect.any(Function),
        c: expect.any(Object),
        t: expect.any(Object),
        inject: expect.any(Object),
        logging: expect.any(Object),
      }),
    )

    expect(mod.logging).toEqual({ console: expect.any(Function) })
    expect(mod.inject).toEqual(
      expect.objectContaining({
        logger: expect.any(Function),
        connection: expect.any(Object),
        jobManager: expect.any(Object),
        publish: expect.any(Object),
        produce: expect.any(Object),
      }),
    )

    expect(mod).not.toHaveProperty('default')
    expect(mod).not.toHaveProperty('n')
    expect(mod).not.toHaveProperty('neemata')
  })

  it('publishes only the root package entry', async () => {
    const pkg = JSON.parse(
      await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    )

    expect(pkg).not.toHaveProperty('bin')
    expect(Object.keys(pkg.exports)).toEqual(['.'])
    expect(Object.keys(pkg.publishConfig.exports)).toEqual(['.'])
  })
})
