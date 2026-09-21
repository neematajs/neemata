import { describe, it } from 'vitest'

import { expectEnvironment } from './support/env-files.ts'

describe.runIf(process.versions.bun)('Neem environment files on Bun', () => {
  it('inherits automatic .env and .env.local loading in development', async () => {
    await expectEnvironment({
      nodeEnv: 'development',
      expected: {
        NEEM_TEST_FILE_VALUE: 'local',
        NEEM_TEST_EXPANDED: 'local-expanded',
        NEEM_TEST_FALLBACK_VALUE: 'fallback',
      },
    })
  }, 45_000)

  it('inherits .env but skips .env.local with NODE_ENV=test', async () => {
    await expectEnvironment({
      expected: {
        NEEM_TEST_FILE_VALUE: 'base',
        NEEM_TEST_EXPANDED: undefined,
        NEEM_TEST_FALLBACK_VALUE: 'fallback',
      },
    })
  }, 45_000)

  it.each(['.env.local', '.env.local,.env'])(
    'preserves automatically loaded values when Neem loads %s',
    async (paths) => {
      // Bun loads .env before the CLI. Dotenvx preserves those process values.
      await expectEnvironment({
        paths,
        expected: {
          NEEM_TEST_FILE_VALUE: 'base',
          NEEM_TEST_EXPANDED: 'base-expanded',
          NEEM_TEST_FALLBACK_VALUE: 'fallback',
        },
      })
    },
    45_000,
  )

  it('loads an explicit custom file without overriding Bun or shell values', async () => {
    await expectEnvironment({
      nodeEnv: 'development',
      paths: 'custom.env',
      expected: {
        NEEM_TEST_FILE_VALUE: 'local',
        NEEM_TEST_EXPANDED: 'local-expanded',
        NEEM_TEST_FALLBACK_VALUE: 'fallback',
        NEEM_TEST_EXTRA_VALUE: 'extra',
      },
    })
  }, 45_000)
})
