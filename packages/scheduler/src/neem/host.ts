import { pathToFileURL } from 'node:url'

import { closeJobsClient, resolveJobsClient } from '@nmtjs/jobs'
import { defineRuntimeHost } from '@nmtjs/neem'

import type { SchedulerConfig } from '../scheduler.ts'
import { JobSchedulerController, resolveSchedulerConfig } from '../scheduler.ts'

type SchedulerRuntimeState = {
  config: Awaited<ReturnType<typeof resolveSchedulerConfig>>
  controller?: JobSchedulerController
}

const states = new Map<string, SchedulerRuntimeState>()

export default defineRuntimeHost({
  async setup(ctx) {
    const config = (await import(pathToFileURL(ctx.artifact.file).href))
      .default as SchedulerConfig
    const resolved = await resolveSchedulerConfig(config)
    states.set(ctx.name, { config: resolved })
  },

  async start(ctx) {
    const state = getState(ctx.name)
    const client = await resolveJobsClient(state.config.client)
    const controller = new JobSchedulerController({
      owner: ctx.name,
      client,
      jobs: state.config.jobs,
    })

    try {
      if (state.config.handoff === 'cutover') {
        await controller.removeOwned()
      }
      await controller.reconcile(state.config.schedules)
      state.controller = controller
      ctx.logger.info(
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

  async stop(ctx) {
    await stopSchedulerRuntime(ctx.name)
  },

  async fail(ctx) {
    await stopSchedulerRuntime(ctx.name)
  },
})

async function stopSchedulerRuntime(name: string) {
  const state = states.get(name)
  if (!state) return
  states.delete(name)

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

function getState(name: string): SchedulerRuntimeState {
  const state = states.get(name)
  if (!state) throw new Error(`Scheduler runtime [${name}] is not initialized`)
  return state
}
