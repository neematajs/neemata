import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { discoverConfigEntriesSync } from '../../../packages/neem/src/internal/build/discovery.ts'

const fixturesDir = dirname(fileURLToPath(import.meta.url))
const configFile = resolve(fixturesDir, '../fixtures/neem.config.ts')

describe('neem config static discovery', () => {
  it('discovers runtime lazy import entries without executing them', () => {
    const discovery = discoverConfigEntriesSync(configFile)

    expect(discovery.runtimes.api).toMatchObject({
      name: 'api',
      entry: {
        specifier: './basic-app.ts',
        resolved: resolve(fixturesDir, '../fixtures/basic-app.ts'),
      },
      build: {
        specifier: './basic-app.build.ts',
        resolved: resolve(fixturesDir, '../fixtures/basic-app.build.ts'),
      },
    })

    expect(discovery.logger).toMatchObject({
      specifier: './logger.ts',
      resolved: resolve(fixturesDir, '../fixtures/logger.ts'),
    })
    expect(discovery.hasInlineLogger).toBe(false)
  })

  it('accepts inline logger config without static import discovery', () => {
    const discovery = discoverConfigEntriesSync(
      resolve(fixturesDir, '../fixtures/inline-logger.config.ts'),
      `
        import { createLogger } from '@nmtjs/core'
        import { defineConfig } from '@nmtjs/neem'

        export default defineConfig({
          logger: createLogger({}, 'test'),
          runtimes: {},
        })
      `,
    )

    expect(discovery.logger).toBeUndefined()
    expect(discovery.hasInlineLogger).toBe(true)
  })

  it('discovers logger module string and URL specifiers', () => {
    const stringDiscovery = discoverConfigEntriesSync(
      resolve(fixturesDir, '../fixtures/logger-string.config.ts'),
      `
        import { defineConfig } from '@nmtjs/neem'

        export default defineConfig({
          logger: './logger.ts',
          runtimes: {},
        })
      `,
    )
    const urlDiscovery = discoverConfigEntriesSync(
      resolve(fixturesDir, '../fixtures/logger-url.config.ts'),
      `
        import { defineConfig } from '@nmtjs/neem'

        export default defineConfig({
          logger: new URL('./logger.ts', import.meta.url),
          runtimes: {},
        })
      `,
    )

    expect(stringDiscovery.logger).toMatchObject({
      specifier: './logger.ts',
      resolved: resolve(fixturesDir, '../fixtures/logger.ts'),
    })
    expect(urlDiscovery.logger).toMatchObject({
      specifier: './logger.ts',
      resolved: resolve(fixturesDir, '../fixtures/logger.ts'),
    })
  })

  it('rejects computed entry imports for direct config discovery', () => {
    expect(() =>
      discoverConfigEntriesSync(
        resolve(fixturesDir, '../fixtures/computed.config.ts'),
        `
          import { defineConfig } from '@nmtjs/neem'
          const entry = './basic-app.ts'
          export default defineConfig({
            runtimes: {
              api: {
                entry: () => import(entry),
              },
            },
          })
        `,
      ),
    ).toThrow("Expected api.entry to be () => import('<literal>')")
  })

  it('only discovers defineConfig from default export', () => {
    expect(() =>
      discoverConfigEntriesSync(
        resolve(fixturesDir, '../fixtures/non-default.config.ts'),
        `
          import { defineConfig } from '@nmtjs/neem'

          const unused = defineConfig({
            runtimes: {
              api: {
                entry: () => import('./basic-app.ts'),
              },
            },
          })

          export default {}
        `,
      ),
    ).toThrow('Failed to find defineConfig({...})')
  })

  it('rejects inline build config', () => {
    expect(() =>
      discoverConfigEntriesSync(
        resolve(fixturesDir, '../fixtures/inline-build.config.ts'),
        `
          import { defineConfig } from '@nmtjs/neem'

          export default defineConfig({
            runtimes: {
              api: {
                entry: () => import('./basic-app.ts'),
                build: { plugins: [] },
              },
            },
          })
        `,
      ),
    ).toThrow("Expected build to be () => import('<literal>')")
  })

  it('rejects computed runtime names', () => {
    expect(() =>
      discoverConfigEntriesSync(
        resolve(fixturesDir, '../fixtures/computed-runtime-name.config.ts'),
        `
          import { defineConfig } from '@nmtjs/neem'
          const runtimeName = 'api'

          export default defineConfig({
            runtimes: {
              [runtimeName]: {
                entry: () => import('./basic-app.ts'),
              },
            },
          })
        `,
      ),
    ).toThrow('Expected runtime name to be a static property name')
  })

  it('rejects duplicate runtime names', () => {
    expect(() =>
      discoverConfigEntriesSync(
        resolve(fixturesDir, '../fixtures/duplicate-runtime-name.config.ts'),
        `
          import { defineConfig } from '@nmtjs/neem'

          export default defineConfig({
            runtimes: {
              api: {
                entry: () => import('./basic-app.ts'),
              },
              'api': {
                entry: () => import('./runtime-app.ts'),
              },
            },
          })
        `,
      ),
    ).toThrow('Duplicate Neem runtime name [api]')
  })
})
