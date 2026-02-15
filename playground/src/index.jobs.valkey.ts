import { JobWorkerPool, n, StoreType } from 'nmtjs'

import { jobs } from './applications/main/jobs.ts'

const valkeyHost = process.env.VALKEY_HOST ?? '127.0.0.1'
const valkeyPort = Number.parseInt(process.env.VALKEY_PORT ?? '6379', 10)

export default n.server({
  logger: { pinoOptions: { level: 'trace' } },
  applications: {
    main: {
      threads: [
        {
          ws: { listen: { port: 0, hostname: '127.0.0.1' } },
          http: { listen: { port: 0, hostname: '127.0.0.1' } },
        },
      ],
    },
  },
  store: {
    type: StoreType.Valkey,
    options: {
      host: valkeyHost,
      port: Number.isNaN(valkeyPort) ? 6379 : valkeyPort,
      maxRetriesPerRequest: null,
    },
  },
  jobs: {
    pools: {
      [JobWorkerPool.Io]: { threads: 1, jobs: 1 },
      [JobWorkerPool.Compute]: { threads: 1, jobs: 1 },
    },
    jobs: [jobs.quick, jobs.slow, jobs.checkpoint, jobs.hung],
  },
  metrics: {},
  proxy: {
    port: 4000,
    hostname: '127.0.0.1',
    applications: { main: { routing: { default: true } } },
  },
})
