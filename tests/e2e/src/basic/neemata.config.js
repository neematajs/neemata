import { defineConfig } from 'nmtjs/config'

export default defineConfig({
  applications: {
    main: {
      specifier: './src/basic/applications/main/index.ts',
      type: 'neemata',
    },
  },
  serverPath: './src/basic/server.ts',
  externalDependencies: [],
  vite: { build: { minify: false } },
})
