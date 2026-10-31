import { defineProject } from 'vitest/config'

const includeIntegration = process.argv.some((arg) =>
  arg.includes('tests/integration'),
)

export default defineProject({
  test: {
    environment: 'node',
    testTimeout: includeIntegration ? 60_000 : 10_000,
    include: includeIntegration
      ? ['tests/integration/**/*.spec.ts']
      : ['tests/*.spec.ts'],
    // Integration scenarios race real workers and processes on real clocks:
    // one retry absorbs a rare miss under load without hiding a regression.
    retry: includeIntegration ? 1 : 0,
    // They spawn processes and hold many connections to servers they share;
    // one file at a time keeps their deadlines meaningful.
    fileParallelism: includeIntegration ? false : undefined,
  },
})
