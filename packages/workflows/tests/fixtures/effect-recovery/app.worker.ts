import { defineWorkflowsWorker } from '@nmtjs/workflows/effect/neem'

import { config, services } from './config.ts'

export default defineWorkflowsWorker(config, services)
