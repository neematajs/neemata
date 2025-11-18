import { defineConfig } from 'nmtjs/config'

export default defineConfig({
  applications: { test: 'neemata-test-playground-app-1' },
  externalDependencies: [],
  build: { minify: true },
  plugins: [],
})
