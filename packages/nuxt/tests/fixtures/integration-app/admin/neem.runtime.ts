import { createNuxtRuntime } from '@nmtjs/nuxt'

export default createNuxtRuntime({
  name: 'admin',
  root: import.meta.dirname,
  base: '/admin/',
  proxy: { routing: { type: 'path' } },
})
