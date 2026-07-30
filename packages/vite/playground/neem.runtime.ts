import { createViteRuntime } from '@nmtjs/vite'

export default createViteRuntime({
  name: 'web',
  root: import.meta.dirname,
  proxy: { routing: { type: 'default' } },
})
