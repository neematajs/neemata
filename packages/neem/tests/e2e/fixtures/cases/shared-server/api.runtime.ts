import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'api',
  planner: './api.planner.ts',
  proxy: { routing: { type: 'default' } },
  worker: {
    entry: './shared-server.worker.ts',
    // uWS loads its .node binary via a runtime-computed require that
    // bundling cannot see; keep it external and resolve from node_modules
    build: { rolldown: { external: ['uWebSockets.js'] } },
  },
})
