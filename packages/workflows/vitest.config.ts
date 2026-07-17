import { defineProject } from 'vitest/config'

const includeIntegration = process.argv.some((arg) =>
  arg.includes('tests/integration'),
)

export default defineProject({
  test: {
    environment: 'node',
    testTimeout: 60_000,
    include: includeIntegration
      ? ['tests/integration/**/*.spec.ts']
      : ['tests/*.spec.ts'],
    // integration scenarios race real workers on real clocks; absorb rare
    // load-induced timing misses without masking consistent regressions
    retry: includeIntegration ? 1 : 0,
    // integration specs share one Postgres database and truncate the same
    // workflow tables per harness; parallel spec files deadlock TRUNCATE
    // against in-flight worker transactions (issue #257)
    fileParallelism: includeIntegration ? false : undefined,
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
  },
})
