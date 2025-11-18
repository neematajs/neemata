// import { ApplicationType, ApplicationWorkerType } from '@nmtjs/application'
import { runMain } from 'citty'

import command from '../command.ts'
import createWorker from './worker.ts'

const worker = await createWorker({
  applicationWorkerData: undefined,
  // type: ApplicationType.Command,
  // workerType: ApplicationWorkerType.Command,
})

runMain(command(worker))
