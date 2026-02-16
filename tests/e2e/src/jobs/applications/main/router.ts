import { n } from 'nmtjs'

import { jobs } from './jobs.ts'
import {
  cancelJobProcedure,
  getJobInfoProcedure,
  getJobProcedure,
  retryJobProcedure,
  startCheckpointJobProcedure,
  startHungJobProcedure,
  startParallelConflictJobProcedure,
  startParallelJobProcedure,
  startQuickJobProcedure,
  startSlowJobProcedure,
} from './procedures/jobs.ts'

export const router = n.rootRouter([
  n.router({
    routes: {
      startQuickJob: startQuickJobProcedure,
      startSlowJob: startSlowJobProcedure,
      startCheckpointJob: startCheckpointJobProcedure,
      startHungJob: startHungJobProcedure,
      startParallelJob: startParallelJobProcedure,
      startParallelConflictJob: startParallelConflictJobProcedure,
      getJob: getJobProcedure,
      getJobInfo: getJobInfoProcedure,
      cancelJob: cancelJobProcedure,
      retryJob: retryJobProcedure,
    },
  }),
  n.jobRouter({ jobs }),
])
