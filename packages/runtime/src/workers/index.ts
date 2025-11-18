import assert from 'node:assert'

import type { Application, ApplicationWorkerType } from '@nmtjs/application'
import type { RedisOptions } from 'ioredis'
import { createPromise } from '@nmtjs/common'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'

import type { JobTaskResult, WorkerJobTask } from '../types.ts'
import { ApplicationWorkerJobRunner } from '../jobs/runner.ts'

export class ApplicationWorkerRuntime {
  jobRunner?: ApplicationWorkerJobRunner
  redisClient?: Redis
  isTerminating: Promise<void> | null = null
  isStarting: Promise<void> | null = null

  constructor(
    readonly type: ApplicationWorkerType,
    readonly app: Application,
    readonly redisOptions?: RedisOptions,
  ) {
    if (redisOptions) {
      this.redisClient = new Redis(redisOptions)
      this.jobRunner = new ApplicationWorkerJobRunner({
        logger: app.logger,
        registry: app.registry,
        container: app.container,
        lifecycleHooks: app.lifecycleHooks,
      })
    }

    process.once('SIGTERM', this.stop.bind(this))
    process.once('SIGINT', this.stop.bind(this))
  }

  async start() {
    if (this.isStarting) return this.isStarting
    const { promise, reject, resolve } = createPromise<void>()
    this.isStarting = promise
    try {
      await this.isTerminating
      await this.app.start()
      resolve()
    } catch (error) {
      reject(error)
    } finally {
      this.isStarting = null
    }
  }

  async stop() {
    if (this.isTerminating) return this.isTerminating
    this.isTerminating = this.app.stop()
    return this.isTerminating
  }

  async runCommand(
    name: string,
    args: string[],
    kwargs: Record<string, string>,
  ) {
    await this.app.initialize()
    return await this.app.commands.executeCommandByName(name, args, kwargs)
  }

  async runJob(payload: WorkerJobTask): Promise<JobTaskResult> {
    assert(
      this.jobRunner && this.redisClient,
      'Redis client is not initialized. Please, provide redis options to server configuration to enable job running.',
    )
    const job = this.app.registry.jobs.get(payload.jobName)

    if (!job || job.options.queue !== this.type)
      return { type: 'job_not_found' }
    const { unregister, signal } = this.app.lifecycleHooks.createSignal(
      LifecycleHook.StopBefore,
    )
    const runLogger = this.app.logger.child({
      jobId: payload.jobId,
      jobName: payload.jobName,
    })
    try {
      const queue = new Queue(this.type, { connection: this.redisClient })
      const queueJob = await queue.getJob(payload.jobId)
      if (!queueJob) return { type: 'queue_job_not_found' }
      const {
        result = {},
        stepResults = [],
        stepIndex = 0,
      } = (queueJob.progress || {}) as {
        result: Record<string, unknown>
        stepResults: any[]
        stepIndex: number
      }
      runLogger.debug(
        { result, stepResults, stepIndex },
        'Running job in worker',
      )
      const runResult = await this.jobRunner.runJob(job, queueJob.data, {
        queueJob,
        signal,
        result,
        stepResults,
        currentStepIndex: stepIndex,
      })
      runLogger.debug(runResult, 'Job run completed in worker')
      return { type: 'success', result: runResult.result }
    } catch (error) {
      runLogger.error(error, 'Error running job in worker')
      return { type: 'error', error: error as Error }
    } finally {
      unregister()
    }
  }
}
