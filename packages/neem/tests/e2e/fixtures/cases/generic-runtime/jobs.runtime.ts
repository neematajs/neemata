import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'jobs',
  env: {
    NEEM_ENV_RUNTIME_ONLY: 'runtime',
    NEEM_ENV_LAYERED: 'runtime',
    NEEM_ENV_EXECUTION_OVERRIDE: 'runtime',
  },
  planner: './jobs.planner.ts',
  worker: { entry: '../../shared/workers/generic-runtime.ts' },
  host: { entry: './jobs.host.ts' },
})
