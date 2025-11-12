import assert from 'node:assert'
import EventEmitter from 'node:events'

import type { Application, ApplicationWorkerType } from '@nmtjs/application'
import type { RedisOptions } from 'ioredis'
import { LifecycleHook } from '@nmtjs/application'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'

import type { JobTaskResult, WorkerJobTask } from './types.ts'
import { ApplicationWorkerJobRunner } from './job-runner.ts'

export class ApplicationWorker extends EventEmitter<{ start: []; stop: [] }> {
  jobRunner?: ApplicationWorkerJobRunner
  redisClient?: Redis
  isTerminating = false

  constructor(
    readonly type: ApplicationWorkerType,
    readonly app: Application,
    readonly redisOptions?: RedisOptions,
  ) {
    super()

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
    await this.app.start()
    this.emit('start')
  }

  async stop() {
    if (this.isTerminating) return
    this.isTerminating = true
    await this.app.stop()
    this.emit('stop')
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

    if (!job || job.options.type !== this.type) return { type: 'job_not_found' }
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
