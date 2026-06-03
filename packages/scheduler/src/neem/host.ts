import { closeJobsClient, resolveJobsClient } from '@nmtjs/jobs'
import { defineRuntimeHost } from '@nmtjs/neem'

import type { SchedulerConfig } from '../scheduler.ts'
import type { SchedulerPlannerFactory } from './runtime.ts'
import { JobSchedulerController, resolveSchedulerConfig } from '../scheduler.ts'

type SchedulerRuntimeState = {
  resolved?: Awaited<ReturnType<typeof resolveSchedulerConfig>>
  controller?: JobSchedulerController
}

export default defineRuntimeHost<SchedulerPlannerFactory | undefined>(
  (params) => {
    const factory = params.options
    if (!factory)
      throw new Error('Scheduler runtime planner options are missing')

    const state: SchedulerRuntimeState = {}

    async function stopSchedulerRuntime(
      options: { removeOwned?: boolean } = {},
    ) {
      const controller = state.controller
      const resolved = state.resolved
      if (!controller || !resolved) return

      try {
        if (options.removeOwned && resolved.handoff === 'cutover') {
          params.logger.info('Neem scheduler cutover stopping')
          const result = await controller.removeOwned({
            reason: 'cutover-stop',
          })
          params.logger.info('Neem scheduler cutover stopped')
          params.logger.trace(
            { handoff: resolved.handoff, result },
            'Neem scheduler cutover stop result',
          )
        }
      } finally {
        await controller.close()
        await closeJobsClient(controller.options.client)
        state.controller = undefined
        state.resolved = undefined
      }
    }

    return {
      async start() {
        const config = (await factory()) as SchedulerConfig
        const resolved = await resolveSchedulerConfig(config)
        const client = await resolveJobsClient(resolved.client)
        const controller = new JobSchedulerController({
          owner: params.name,
          client,
          jobs: resolved.jobs,
          logger: params.logger,
        })

        try {
          if (resolved.handoff === 'cutover') {
            params.logger.info('Neem scheduler cutover starting')
            const cutover = await controller.removeOwned({
              reason: 'cutover-start',
            })
            params.logger.info('Neem scheduler cutover started')
            params.logger.trace(
              { handoff: resolved.handoff, result: cutover },
              'Neem scheduler cutover start result',
            )
          }
          const result = await controller.reconcile(resolved.schedules)
          state.controller = controller
          state.resolved = resolved
          params.logger.info('Neem scheduler runtime reconciled')
          params.logger.trace(
            {
              schedules: resolved.schedules.length,
              handoff: resolved.handoff,
              result,
            },
            'Neem scheduler runtime reconcile result',
          )
        } catch (error) {
          params.logger.error(
            {
              err: normalizeError(error),
              schedules: resolved.schedules.length,
              handoff: resolved.handoff,
            },
            'Failed to start Neem scheduler runtime',
          )
          await controller.close()
          await closeJobsClient(client)
          throw error
        }
      },

      async stop() {
        await stopSchedulerRuntime({ removeOwned: true })
      },
    }
  },
)

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
