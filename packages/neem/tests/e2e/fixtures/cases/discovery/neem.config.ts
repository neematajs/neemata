import { defineConfig } from './neem.ts'

export default defineConfig({
  runtimes: ['./packages/*', '!./packages/legacy'],
})
