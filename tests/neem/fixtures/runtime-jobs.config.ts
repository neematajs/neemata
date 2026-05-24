import { defineJobsRuntimeArtifacts } from '@nmtjs/jobs/neem'
import { defineConfig, defineRuntimeConfig } from '@nmtjs/neem'

export default defineConfig({
  runtimes: {
    jobs: defineRuntimeConfig({
      entry: () => import('./runtime-jobs.ts'),
      host: () => import('@nmtjs/jobs/neem/host'),
      artifacts: defineJobsRuntimeArtifacts,
    }),
  },
})
