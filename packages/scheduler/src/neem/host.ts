import { pathToFileURL } from 'node:url'

import { closeJobsClient, resolveJobsClient } from '@nmtjs/jobs'
import { defineRuntimeHost } from '@nmtjs/neem'

import type { SchedulerConfig } from '../scheduler.ts'
import { JobSchedulerController, resolveSchedulerConfig } from '../scheduler.ts'

type SchedulerRuntimeState = {
  config: Awaited<ReturnType<typeof resolveSchedulerConfig>>
  controller?: JobSchedulerController
}

export default defineRuntimeHost(async (params) => {
  const config = (await import(pathToFileURL(params.artifact.file).href))
    .default as SchedulerConfig
  const resolved = await resolveSchedulerConfig(config)
  const state: SchedulerRuntimeState = { config: resolved }

  async function stopSchedulerRuntime() {
    const controller = state.controller
    if (!controller) return

    try {
      if (state.config.handoff === 'cutover') {
        await controller.removeOwned()
      }
    } finally {
      await controller.close()
      await closeJobsClient(controller.options.client)
      state.controller = undefined
    }
  }

  return {
    async start() {
      const client = await resolveJobsClient(state.config.client)
      const controller = new JobSchedulerController({
        owner: params.name,
        client,
        jobs: state.config.jobs,
      })

      try {
        if (state.config.handoff === 'cutover') {
          await controller.removeOwned()
        }
        await controller.reconcile(state.config.schedules)
        state.controller = controller
        params.logger.info(
          {
            schedules: state.config.schedules.length,
            handoff: state.config.handoff,
          },
          'Neem scheduler runtime reconciled',
        )
      } catch (error) {
        await controller.close()
        await closeJobsClient(client)
        throw error
      }
    },

    async stop() {
      await stopSchedulerRuntime()
    },

    async fail() {
      await stopSchedulerRuntime()
    },
  }
})
