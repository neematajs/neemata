import { pathToFileURL } from 'node:url'

import { closeJobsClient, resolveJobsClient } from '@nmtjs/jobs'
import { defineRuntimeHost } from '@nmtjs/neem'

import type { SchedulerConfig } from '../scheduler.ts'
import { JobSchedulerController, resolveSchedulerConfig } from '../scheduler.ts'
import { schedulerConfigArtifactId } from './runtime.ts'

type SchedulerRuntimeState = {
  config: Awaited<ReturnType<typeof resolveSchedulerConfig>>
  controller?: JobSchedulerController
}

export default defineRuntimeHost(async (params) => {
  const configArtifact = params.artifacts.resolve(schedulerConfigArtifactId)
  if (!configArtifact) {
    throw new Error(
      `Scheduler runtime config artifact [${schedulerConfigArtifactId}] is missing`,
    )
  }

  const config = (await import(pathToFileURL(configArtifact.file).href))
    .default as SchedulerConfig
  const resolved = await resolveSchedulerConfig(config)
  const state: SchedulerRuntimeState = { config: resolved }

  async function stopSchedulerRuntime(options: { removeOwned?: boolean } = {}) {
    const controller = state.controller
    if (!controller) return

    try {
      if (options.removeOwned && state.config.handoff === 'cutover') {
        params.logger.info('Neem scheduler cutover stopping')
        const result = await controller.removeOwned({ reason: 'cutover-stop' })
        params.logger.info('Neem scheduler cutover stopped')
        params.logger.trace(
          { handoff: state.config.handoff, result },
          'Neem scheduler cutover stop result',
        )
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
        logger: params.logger,
      })

      try {
        if (state.config.handoff === 'cutover') {
          params.logger.info('Neem scheduler cutover starting')
          const cutover = await controller.removeOwned({
            reason: 'cutover-start',
          })
          params.logger.info('Neem scheduler cutover started')
          params.logger.trace(
            { handoff: state.config.handoff, result: cutover },
            'Neem scheduler cutover start result',
          )
        }
        const result = await controller.reconcile(state.config.schedules)
        state.controller = controller
        params.logger.info('Neem scheduler runtime reconciled')
        params.logger.trace(
          {
            schedules: state.config.schedules.length,
            handoff: state.config.handoff,
            result,
          },
          'Neem scheduler runtime reconcile result',
        )
      } catch (error) {
        params.logger.error(
          {
            err: normalizeError(error),
            schedules: state.config.schedules.length,
            handoff: state.config.handoff,
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

    async fail() {
      await stopSchedulerRuntime()
    },
  }
})

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
