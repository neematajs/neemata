import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  env: {
    NEEM_ENV_ROOT_ONLY: 'root',
    NEEM_ENV_LAYERED: 'root',
    NEEM_ENV_EXECUTION_OVERRIDE: 'root',
  },
  logger: '../../shared/support/logger.ts',
  runtimes: ['./api.runtime.ts', './jobs.runtime.ts'],
})
