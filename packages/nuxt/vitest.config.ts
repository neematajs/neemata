import { defineProject } from 'vitest/config'

// The unit suite is the default config on purpose: the root `projects` glob
// picks a package up by its default config, and the e2e specs need a prior
// build plus the serial settings in vitest.e2e.config.ts.
export default defineProject({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    typecheck: { enabled: true, tsconfig: './tests/tsconfig.json' },
  },
})
