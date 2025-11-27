import { defineConfig } from 'nmtjs/config'

export default defineConfig({
  applications: {
    test: 'neemata-test-playground-app-1',
    test2: './src/applications/test/index.ts',
  },
  externalDependencies: [],
  build: { minify: false },
  plugins: [],
})
