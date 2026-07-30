import { createNuxtRuntime } from '@nmtjs/nuxt'

export default createNuxtRuntime({
  name: 'web',
  root: import.meta.dirname,
  proxy: { routing: { type: 'default' } },
})
