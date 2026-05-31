import { isMainThread, threadId } from 'node:worker_threads'

import { defineConfig, defineRuntime } from '@nmtjs/neem'

import { record } from './_events.ts'

record({ event: 'config-import', isMainThread, threadId })

export default defineConfig({
  logger: './logger.ts',
  runtimes: {
    api: defineRuntime({
      worker: { entry: './generic-runtime.ts' },
      threads: [{ label: 'isolated' }],
    }),
  },
})
