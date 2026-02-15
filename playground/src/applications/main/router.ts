import { n } from 'nmtjs'

import {
  cancelJobProcedure,
  getJobProcedure,
  retryJobProcedure,
  startCheckpointJobProcedure,
  startHungJobProcedure,
  startQuickJobProcedure,
  startSlowJobProcedure,
} from './procedures/jobs.ts'
import { pingProcedure } from './procedures/ping.ts'
import { streamCountProcedure } from './procedures/stream-count.ts'

export const router = n.rootRouter([
  n.router({
    routes: {
      ping: pingProcedure,
      streamCount: streamCountProcedure,
      startQuickJob: startQuickJobProcedure,
      startSlowJob: startSlowJobProcedure,
      startCheckpointJob: startCheckpointJobProcedure,
      startHungJob: startHungJobProcedure,
      getJob: getJobProcedure,
      cancelJob: cancelJobProcedure,
      retryJob: retryJobProcedure,
    },
  }),
])
