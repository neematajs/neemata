import { defineConfig } from 'nmtjs/config'

export default defineConfig({
  applications: {
    main: {
      specifier: './src/jobs/applications/main/index.ts',
      type: 'neemata',
    },
  },
  serverPath: './src/jobs/server.jobs.redis.ts',
  externalDependencies: [],
  vite: { build: { minify: false } },
})
