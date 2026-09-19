import { defineRuntimeHost } from '@nmtjs/neem'

import type { MaybePromise } from '../types/index.ts'
import type { WorkflowsConfig } from './runtime.ts'

type PlannerFactory = () => MaybePromise<WorkflowsConfig>

export default defineRuntimeHost<PlannerFactory | undefined>(
  async (params) => ({
    async start() {
      // The planner factory is the host's only wiring signal; workers would
      // otherwise start against a runtime nobody configured.
      if (!params.options) {
        throw new Error('Workflows runtime planner options are missing')
      }

      params.logger.debug(
        { threads: params.threads.length },
        'Neem workflows runtime host started',
      )
    },
    stop() {
      params.logger.debug('Neem workflows runtime host stopped')
    },
  }),
)
