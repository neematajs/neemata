import type { MessagePort } from 'node:worker_threads'

import type { JobWorkerQueue } from '../enums.ts'
import type { ServerConfig } from '../server/config.ts'
import { LifecycleHook, WorkerType } from '../enums.ts'
import { jobWorkerQueue } from '../injectables.ts'
import { JobRunner } from '../jobs/runner.ts'
import { BaseWorkerRuntime } from './base.ts'

export interface JobWorkerRuntimeOptions {
  queueName: string
  port: MessagePort
}

export class JobWorkerRuntime extends BaseWorkerRuntime {
  jobRunner!: JobRunner

  constructor(
    readonly config: ServerConfig,
    readonly runtimeOptions: JobWorkerRuntimeOptions,
  ) {
    super(
      config,
      { logger: config.logger, name: `Job Worker ${runtimeOptions.queueName}` },
      WorkerType.Job,
    )
  }

  async start() {
    await this.initialize()
    await this.hooks.callHook(LifecycleHook.Start)
  }

  async stop() {
    await this.hooks.callHook(LifecycleHook.Stop)
    await this.dispose()
  }

  async initialize(): Promise<void> {
    await this.container.provide(
      jobWorkerQueue,
      this.runtimeOptions.queueName as JobWorkerQueue,
    )
    await super.initialize()
  }

  protected async _initialize(): Promise<void> {
    await super._initialize()

    this.jobRunner = new JobRunner({
      logger: this.logger,
      container: this.container,
      lifecycleHooks: this.hooks,
    })

    this.runtimeOptions.port.on('message', async (msg) => {
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
            })
            return
          }
          const result = await this.jobRunner.runJob(job, task.data)
          this.runtimeOptions.port.postMessage({
            type: 'task',
            data: { id, task: { type: 'success', result } },
          })
        } catch (error) {
          this.runtimeOptions.port.postMessage({
            type: 'task',
            data: { id, task: { type: 'error', error } },
          })
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
