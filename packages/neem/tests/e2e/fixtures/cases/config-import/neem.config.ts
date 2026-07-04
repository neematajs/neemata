import { isMainThread, threadId } from 'node:worker_threads'

import { defineConfig } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

record({ event: 'config-import', isMainThread, threadId })

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  runtimes: ['./api.runtime.ts'],
})
