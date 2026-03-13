import { resolve } from 'node:path'

import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  server: resolve(import.meta.dirname, './server.js'),
  applications: {
    node: resolve(import.meta.dirname, './node.config.js'),
    nmtjs: resolve(import.meta.dirname, './nmtjs.config.js'),
  },
})
