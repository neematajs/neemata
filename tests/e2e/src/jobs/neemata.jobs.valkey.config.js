import { defineConfig } from 'nmtjs/config'

export default defineConfig({
  applications: {
    main: {
      specifier: './src/jobs/applications/main/host.ts',
      type: 'neemata',
    },
  },
  serverPath: './src/jobs/server.jobs.valkey.ts',
  externalDependencies: [],
  vite: { build: { minify: false } },
})
