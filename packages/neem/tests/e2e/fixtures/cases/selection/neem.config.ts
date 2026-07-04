import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  runtimes: ['./api.runtime.ts', './jobs.runtime.ts'],
})
