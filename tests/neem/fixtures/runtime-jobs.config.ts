import { defineJobsRuntime } from '@nmtjs/jobs/neem'
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  runtimes: { jobs: defineJobsRuntime({ config: './runtime-jobs.ts' })() },
})
