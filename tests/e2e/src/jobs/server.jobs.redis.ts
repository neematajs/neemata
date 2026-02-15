import { JobWorkerPool, n, StoreType } from 'nmtjs'

import { jobs } from './applications/main/jobs.ts'

const redisHost = process.env.REDIS_HOST ?? '127.0.0.1'
const redisPort = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10)

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
    type: StoreType.Redis,
    options: {
      host: redisHost,
      port: Number.isNaN(redisPort) ? 6379 : redisPort,
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
