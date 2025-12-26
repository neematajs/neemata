import type { MessagePort } from 'node:worker_threads'

import { UnrecoverableError } from 'bullmq'

import type { JobWorkerPool } from '../enums.ts'
import type { ServerConfig } from '../server/config.ts'
import type { ServerPortMessage, ThreadPortMessage } from '../types.ts'
import { LifecycleHook, WorkerType } from '../enums.ts'
import { jobWorkerPool } from '../injectables.ts'
import { ApplicationWorkerJobRunner } from '../jobs/runner.ts'
import { BaseWorkerRuntime } from './base.ts'

export interface JobWorkerRuntimeOptions {
  poolName: string
  port: MessagePort
}

export class JobWorkerRuntime extends BaseWorkerRuntime {
  jobRunner!: ApplicationWorkerJobRunner

  constructor(
    readonly config: ServerConfig,
    readonly runtimeOptions: JobWorkerRuntimeOptions,
  ) {
    super(
      config,
      { logger: config.logger, name: `Job Worker ${runtimeOptions.poolName}` },
      WorkerType.Job,
    )
  }

  async start() {
    await this.initialize()
    await this.lifecycleHooks.callHook(LifecycleHook.Start)
  }

  async stop() {
    await this.lifecycleHooks.callHook(LifecycleHook.Stop)
    await this.dispose()
  }

  async initialize(): Promise<void> {
    await this.container.provide(
      jobWorkerPool,
      this.runtimeOptions.poolName as JobWorkerPool,
    )
    await super.initialize()
  }

  protected async _initialize(): Promise<void> {
    await super._initialize()

    this.jobRunner = new ApplicationWorkerJobRunner({
      logger: this.logger,
      container: this.container,
      lifecycleHooks: this.lifecycleHooks,
    })

    this.runtimeOptions.port.on('message', async (msg: ServerPortMessage) => {
      if (msg.type === 'task') {
        const { id, task } = msg.data
        try {
          const job = this.config.jobs?.jobs.find(
            (j) => j.name === task.jobName,
          )
          if (!job) {
            this.runtimeOptions.port.postMessage({
              type: 'task',
              data: { id, task: { type: 'job_not_found' } },
            } satisfies ThreadPortMessage)
            return
          }

          using cancellationSignal = this.jobManager!.cancellationSignal(
            job,
            task.jobId,
          )
          const queue = this.jobManager!.getQueue(job).queue
          const bullJob = await queue.getJob(task.jobId)
          if (!bullJob) {
            throw new UnrecoverableError(
              `Job ${task.jobId} not found in queue (may have been removed)`,
            )
          }

          // Load checkpoint from BullMQ progress for resume support
          const progress = bullJob.progress as
            | {
                stepIndex: number
                result: Record<string, unknown>
                stepResults: unknown[]
              }
            | undefined

          const result = await this.jobRunner.runJob(job, task.data, {
            signal: cancellationSignal,
            queueJob: bullJob,
            result: progress?.result,
            stepResults: progress?.stepResults,
            currentStepIndex: progress?.stepIndex ?? 0,
          })
          this.runtimeOptions.port.postMessage({
            type: 'task',
            data: { id, task: { type: 'success', result } },
          })
        } catch (error) {
          if (error instanceof UnrecoverableError) {
            this.runtimeOptions.port.postMessage({
              type: 'task',
              data: {
                id,
                task: { type: 'unrecoverable_error', error: error.message },
              },
            } satisfies ThreadPortMessage)
          } else {
            this.runtimeOptions.port.postMessage({
              type: 'task',
              data: { id, task: { type: 'error', error } },
            } satisfies ThreadPortMessage)
          }
        }
      }
    })
  }

  protected async _dispose(): Promise<void> {
    this.runtimeOptions.port.removeAllListeners('message')
    await super._dispose()
  }

  protected *_dependents() {
    if (this.config?.jobs) {
      for (const job of this.config.jobs.jobs) {
        if (!job.returnHandler)
          throw new Error(`Job ${job.name} is missing return handler.`)
        yield job
      }
    }
  }
}
