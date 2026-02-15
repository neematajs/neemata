import { defineConfig } from 'nmtjs/config'

export default defineConfig({
  applications: {
    main: { specifier: './src/applications/main/index.ts', type: 'neemata' },
  },
  serverPath: './src/index.jobs.valkey.ts',
  externalDependencies: [],
  vite: { build: { minify: false } },
})
