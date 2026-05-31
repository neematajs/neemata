import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  runtimes: {
    api: defineRuntime({
      worker: { entry: './selection-runtime.ts' },
      threads: [{ label: 'api' }],
    }),
    jobs: defineRuntime({
      worker: { entry: './selection-runtime.ts' },
      threads: [{ label: 'jobs' }],
    }),
  },
})
