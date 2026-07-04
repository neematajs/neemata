import type { InferNeemRuntimeWorkerData } from '@nmtjs/neem'
import { defineRuntimePlanner } from '@nmtjs/neem'

import type worker from './api.worker.js'

type WorkerData = InferNeemRuntimeWorkerData<typeof worker>

const workerData = { message: 'packaging-smoke' } satisfies WorkerData

export default defineRuntimePlanner(() => ({ workers: [workerData] }))
