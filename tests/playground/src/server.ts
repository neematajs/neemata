import { ApplicationWorkerType, n, t } from 'nmtjs'
import { createSchedulerJobEntry, defineServer } from 'nmtjs/server'

export default defineServer({
  deploymentId: import.meta.env.PROD ? 'production-deployment' : undefined,
  logger: { pinoOptions: { level: 'trace' } },
  workers: {
    Api: [1],
    Io: { threadsNumber: 0, jobsPerWorker: 100 },
    Compute: { threadsNumber: 0, jobsPerWorker: 1 },
  },
  redis: {
    host: '127.0.0.1',
    port: 6379,
    db: 0,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  },
  scheduler: {
    entries: [
      // createSchedulerJobEntry(
      //   n
      //     .job(`test-scheduled-compute`, {
      //       type: ApplicationWorkerType.Compute,
      //     })
      //     .add(
      //       n.step({
      //         input: t.object({ testInput: t.string() }),
      //         output: t.object({ msg: t.string() }),
      //         handler: async () => {
      //           console.dir('Scheduled compute job step executed')
      //           return { msg: 'Hello from scheduled compute job step!' }
      //         },
      //       }),
      //     ),
      //   { testInput: 'test' },
      //   '* * * * *',
      // ),
    ],
  },
})
