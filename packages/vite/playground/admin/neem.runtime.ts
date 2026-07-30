import { createViteRuntime } from '@nmtjs/vite'

// Path-routed on purpose: this exercises the riskiest proxy combination —
// the "/admin/" prefix is stripped upstream and must be restored for Vite in
// dev, while the prod build bakes it into asset URLs.
export default createViteRuntime({
  name: 'admin',
  root: import.meta.dirname,
  base: '/admin/',
  proxy: { routing: { type: 'path' } },
})
