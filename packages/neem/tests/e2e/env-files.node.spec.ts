import { describe, it } from 'vitest'

import { expectEnvironment } from './support/env-files.ts'

describe.skipIf(process.versions.bun)('Neem environment files on Node', () => {
  it.each(['.env.local', '.env.local,.env'])(
    'loads only the requested files in order: %s',
    async (paths) => {
      await expectEnvironment({
        paths,
        expected: {
          NEEM_TEST_FILE_VALUE: 'local',
          NEEM_TEST_EXPANDED: 'local-expanded',
          NEEM_TEST_FALLBACK_VALUE: paths.includes(',')
            ? 'fallback'
            : undefined,
        },
      })
    },
    45_000,
  )

  it('does not load local env files without the flag', async () => {
    await expectEnvironment({
      expected: {
        NEEM_TEST_FILE_VALUE: undefined,
        NEEM_TEST_EXPANDED: undefined,
        NEEM_TEST_FALLBACK_VALUE: undefined,
      },
    })
  }, 45_000)
})
