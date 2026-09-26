import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  runtimes: ['./jobs.runtime.ts'],
})
