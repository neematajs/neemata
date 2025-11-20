import { defineServer } from 'nmtjs/runtime'

import { StoreType } from '../../../packages/runtime/src/enums.ts'

export default defineServer({
  deploymentId: import.meta.env.PROD ? 'production-deployment' : undefined,
  logger: { pinoOptions: { level: 'trace' } },
  applications: {
    test: { threads: [{ http: { listen: { hostname: '0.0.0.0', port: 0 } } }] },
  },
  store: {
    type: StoreType.Redis,
    options: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    },
  },
  jobs: {
    jobs: [],
    queues: { Io: { threads: 1, jobs: 100 }, Compute: { threads: 1, jobs: 2 } },
  },

  // scheduler: {
  //   entries: [
  //     // createSchedulerJobEntry(
  //     //   n
  //     //     .job(`test-scheduled-compute`, {
  //     //       type: ApplicationWorkerType.Compute,
  //     //     })
  //     //     .add(
  //     //       n.step({
  //     //         input: t.object({ testInput: t.string() }),
  //     //         output: t.object({ msg: t.string() }),
  //     //         handler: async () => {
  //     //           console.dir('Scheduled compute job step executed')
  //     //           return { msg: 'Hello from scheduled compute job step!' }
  //     //         },
  //     //       }),
  //     //     ),
  //     //   { testInput: 'test' },
  //     //   '* * * * *',
  //     // ),
  //   ],
  // },
})
