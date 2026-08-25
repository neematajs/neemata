import { defineRuntimeHost } from '@nmtjs/neem'

import type { WorkflowsPlannerInput } from './planner.ts'

type WorkflowsPlannerFactory = () =>
  | Promise<WorkflowsPlannerInput>
  | WorkflowsPlannerInput

export default defineRuntimeHost<WorkflowsPlannerFactory | undefined>(
  async (params) => ({
    async start() {
      if (!params.options) {
        throw new Error('Workflows runtime planner options are missing')
      }

      params.logger.debug(
        {
          threads: params.threads.length,
        },
        'Neem workflows runtime host started',
      )
    },
    stop() {
      params.logger.debug('Neem workflows runtime host stopped')
    },
  }),
)
