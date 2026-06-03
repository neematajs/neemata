import type { MessagePort } from 'node:worker_threads'

import { LifecycleHook, LifecycleHooks } from '@nmtjs/application'
import { Container, CoreInjectables, provision } from '@nmtjs/core'
import { defineRuntimeWorker } from '@nmtjs/neem'
import { UnrecoverableError } from 'bullmq'

import type { JobsClientInstance } from '../client.ts'
import type { JobProgressCheckpoint } from '../core/types.ts'
import type { JobsWorkerData, JobsWorkerRequest } from './protocol.ts'
import type { AnyJobsJob, JobsConfig } from './runtime.ts'
import { closeJobsClient, resolveJobsClient } from '../client.ts'
import { jobWorkerPool } from '../core/injectables.ts'
import { JobManager, QueueJobRunner } from '../manager.ts'
import { resolveJobsWorkerConfig } from './runtime.ts'

export type JobsWorkerConfig<Job extends AnyJobsJob = AnyJobsJob> = Pick<
  JobsConfig<Job>,
  'client' | 'jobs'
>

export function defineJobsWorker<const Job extends AnyJobsJob>(
  config: JobsWorkerConfig<Job>,
) {
  return defineRuntimeWorker<JobsWorkerData, JobsWorkerConfig<Job>>({
    definition: config,
    createRuntime(ctx) {
      let client: JobsClientInstance | undefined
      let manager: JobManager | undefined
      let listener: ((message: JobsWorkerRequest) => void) | undefined
      const lifecycleHooks = new LifecycleHooks()
      const container = new Container({ logger: ctx.logger })

      return {
        async start() {
          const resolved = await resolveJobsWorkerConfig(ctx.definition)

          for (const job of resolved.jobs) {
            if (!job.returnHandler) {
              throw new Error(
                `Job "${job.name}" is incomplete. Jobs must call .return() before use.`,
              )
            }
          }

          client = await resolveJobsClient(resolved.client)
          try {
            manager = new JobManager(client, [...resolved.jobs])
            await manager.initialize()
          } catch (error) {
            await closeJobsClient(client)
            client = undefined
            manager = undefined
            throw error
          }

          container.provide([
            provision(CoreInjectables.logger, ctx.logger),
            provision(jobWorkerPool, ctx.data.poolName),
          ])

          const runner = new QueueJobRunner({
            logger: ctx.logger,
            container,
            lifecycleHooks,
          })

          const currentManager = manager
          listener = (message) => {
            if (message.type !== 'task') return
            void runTask({
              message,
              manager: currentManager,
              runner,
              port: ctx.port,
            })
          }
          ctx.port.on('message', listener)
        },
        async stop() {
          if (listener) ctx.port.off('message', listener)
          try {
            await lifecycleHooks.callHook(LifecycleHook.BeforeDispose, {
              logger: ctx.logger,
              container,
            })
            await manager?.terminate()
          } finally {
            manager = undefined
            if (client) await closeJobsClient(client)
            client = undefined
          }
        },
      }
    },
  })
}

async function runTask(options: {
  message: JobsWorkerRequest
  manager: JobManager
  runner: QueueJobRunner
  port: MessagePort
}) {
  const { message, manager, runner, port } = options
  const { task } = message

  try {
    const job = manager.jobs.find((job) => job.name === task.jobName)
    if (!job) {
      port.postMessage({
        type: 'task',
        id: message.id,
        task: { type: 'job_not_found' },
      })
      return
    }

    using cancellationSignal = manager.cancellationSignal(job, task.jobId)
    const queue = manager.getQueue(job).queue
    const bullJob = await queue.getJob(task.jobId)
    if (!bullJob) {
      port.postMessage({
        type: 'task',
        id: message.id,
        task: { type: 'queue_job_not_found' },
      })
      return
    }

    const checkpoint = bullJob.progress as JobProgressCheckpoint | undefined
    const result = await runner.runJob(job, task.data, {
      signal: cancellationSignal,
      queueJob: bullJob,
      result: checkpoint?.result,
      stepResults: checkpoint?.stepResults,
      currentStepIndex: checkpoint?.stepIndex ?? 0,
      progress: checkpoint?.progress,
    })

    port.postMessage({
      type: 'task',
      id: message.id,
      task: { type: 'success', result },
    })
  } catch (error) {
    port.postMessage({
      type: 'task',
      id: message.id,
      task:
        error instanceof UnrecoverableError
          ? { type: 'unrecoverable_error', error }
          : { type: 'error', error },
    })
  }
}
