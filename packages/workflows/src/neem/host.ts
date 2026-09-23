import { defineRuntimeHost } from '@nmtjs/neem'

import type { ResolvedWorkflowsPlan } from './runtime.ts'

export default defineRuntimeHost<ResolvedWorkflowsPlan | undefined>(
  async (params) => ({
    async start() {
      if (!params.options) {
        throw new Error('Workflows runtime planner options are missing')
      }

      params.logger.debug(
        {
          threads: params.threads.length,
          pools: Object.keys(params.options.pools),
        },
        'Neem workflows runtime host started',
      )
    },
    stop() {
      params.logger.debug('Neem workflows runtime host stopped')
    },
  }),
)
