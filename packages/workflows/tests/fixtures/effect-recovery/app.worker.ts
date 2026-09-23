import { defineWorkflowsWorker } from '@nmtjs/workflows/effect/neem'

import { registry, services } from './config.ts'

export default defineWorkflowsWorker({ ...registry, ...services })
