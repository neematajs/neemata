import { defineJobsRuntime } from '@nmtjs/jobs/neem'
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  runtimes: { jobs: defineJobsRuntime({ entry: './runtime-jobs.ts' }) },
})
