import { defineServer } from '@nmtjs/neem'

export default defineServer({
  applications: {
    node: { threads: [{ host: '127.0.0.1', port: 4310 }] },
    nmtjs: {
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 4311 } } }],
    },
  },
  plugins: [],
})
