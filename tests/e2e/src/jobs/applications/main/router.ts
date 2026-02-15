import { n } from 'nmtjs'

import {
  cancelJobProcedure,
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
      cancelJob: cancelJobProcedure,
      retryJob: retryJobProcedure,
    },
  }),
])
