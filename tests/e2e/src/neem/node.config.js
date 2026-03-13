import { resolve } from 'node:path'

import { defineApplicationConfig } from '@nmtjs/neem'

export default defineApplicationConfig({
  entrypoint: resolve(import.meta.dirname, './node.js'),
})
