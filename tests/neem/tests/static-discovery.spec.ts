import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { discoverConfigEntriesSync } from '../../../packages/neem/src/internal/build/discovery.ts'

const fixturesDir = dirname(fileURLToPath(import.meta.url))
const configFile = resolve(fixturesDir, '../fixtures/neem.config.ts')

describe('neem config static discovery', () => {
  it('discovers app and plugin lazy import entries without executing them', () => {
    const discovery = discoverConfigEntriesSync(configFile)
    console.dir(discovery, { depth: null })

    expect(discovery.apps.api).toMatchObject({
      name: 'api',
      entry: {
        specifier: './basic-app.ts',
        resolved: resolve(fixturesDir, '../fixtures/basic-app.ts'),
      },
      build: {
        specifier: './basic-app.build.ts',
        resolved: resolve(fixturesDir, '../fixtures/basic-app.build.ts'),
      },
      hasInlineBuild: false,
    })

    expect(discovery.plugins[0]).toMatchObject({
      index: 0,
      entry: {
        specifier: './jobs.plugin.ts',
        resolved: resolve(fixturesDir, '../fixtures/jobs.plugin.ts'),
      },
      hasInlineBuild: false,
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
            apps: {
              api: {
                entry: () => import(entry),
                threads: [],
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
            apps: {
              api: {
                entry: () => import('./basic-app.ts'),
                threads: [],
              },
            },
          })

          export default {}
        `,
      ),
    ).toThrow('Failed to find defineConfig({...})')
  })
})
