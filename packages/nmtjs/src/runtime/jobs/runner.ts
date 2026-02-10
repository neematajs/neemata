import type { Container, Logger, LoggingOptions } from '@nmtjs/core'
import type { Job } from 'bullmq'
import { anyAbortSignal } from '@nmtjs/common'
import { Scope } from '@nmtjs/core'
import { UnrecoverableError } from 'bullmq'

import type { LifecycleHooks } from '../hooks.ts'
import type { AnyJob } from './job.ts'
import type { AnyJobStep } from './step.ts'
import type {
  JobExecutionContext,
  JobProgressCheckpoint,
  StepResultEntry,
} from './types.ts'
import { LifecycleHook } from '../enums.ts'
import {
  currentJobInfo,
  jobAbortSignal,
  saveJobProgress,
} from '../injectables.ts'

export type JobRunnerOptions = { logging?: LoggingOptions }

export type { StepResultEntry } from './types.ts'

export interface JobRunnerRunOptions {
  signal: AbortSignal
  result: Record<string, unknown>
  stepResults: StepResultEntry[]
  currentStepIndex: number
  progress: Record<string, unknown>
}

export interface JobRunnerRunBeforeStepParams<
  Options extends JobRunnerRunOptions,
> {
  job: AnyJob
  step: AnyJobStep
  stepIndex: number
  result: Record<string, unknown>
  stepResults: StepResultEntry[]
  options: Options
}

export interface JobRunnerRunAfterStepParams<
  Options extends JobRunnerRunOptions,
> extends JobRunnerRunBeforeStepParams<Options> {
  stepResult: StepResultEntry
}

/** Context for saveProgress function - contains mutable state references */
export interface SaveProgressContext<
  Options extends JobRunnerRunOptions = JobRunnerRunOptions,
> {
  job: AnyJob
  progress: Record<string, unknown>
  result: Record<string, unknown>
  stepResults: StepResultEntry[] | null
  currentStepIndex: number
  options: Options | null
}

export class JobRunner<
  RunOptions extends JobRunnerRunOptions = JobRunnerRunOptions,
> {
  logger: Logger

  constructor(
    protected runtime: {
      logger: Logger
      container: Container
      lifecycleHooks: LifecycleHooks
    },
  ) {
    this.logger = runtime.logger.child({ $group: JobRunner.name })
  }

  get container() {
    return this.runtime.container
  }

  /**
   * Creates a function that saves the current job progress state.
   * Override in subclasses to implement actual persistence.
   */
  protected createSaveProgressFn(
    _context: SaveProgressContext<RunOptions>,
  ): () => Promise<void> {
    // No-op in base runner - subclasses implement actual persistence
    return async () => {}
  }

  /**
   * Creates the current job info object.
   * Override in subclasses to include additional info (e.g., BullMQ job ID).
   */
  protected createJobInfo(
    job: AnyJob,
    _options: Partial<RunOptions>,
  ): JobExecutionContext {
    return { name: job.options.name }
  }

  async runJob<T extends AnyJob>(
    job: T,
    data: any,
    options: Partial<RunOptions> = {},
  ): Promise<T['_']['output']> {
    const {
      signal: runSignal,
      result: runResult = {},
      stepResults: runStepResults = [] as RunOptions['stepResults'],
      progress: runProgress = {},
      currentStepIndex = 0,
      ...rest
    } = options

    const { input, output, steps } = job

    const result: Record<string, unknown> = { ...runResult }
    const decodedInput = input.decode(data)

    // Initialize progress: decode from checkpoint or start fresh
    const progress: Record<string, unknown> = job.progress
      ? job.progress.decode(runProgress)
      : { ...runProgress }

    using stopListener = this.runtime.lifecycleHooks.once(
      LifecycleHook.BeforeDispose,
    )
    const signal = anyAbortSignal(runSignal, stopListener.signal)
    await using container = this.container.fork(Scope.Global)
    container.provide(jobAbortSignal, signal)
    container.provide(currentJobInfo, this.createJobInfo(job, options))

    // Create mutable state context for saveProgress
    const progressContext = {
      job,
      progress,
      result,
      stepResults: null as StepResultEntry[] | null, // Will be set below
      currentStepIndex,
      options: null as RunOptions | null, // Will be set below
    }

    // Provide saveProgress injectable
    container.provide(
      saveJobProgress,
      this.createSaveProgressFn(progressContext),
    )

    const jobDependencyContext = await container.createContext(job.dependencies)
    const jobData = job.options.data
      ? await job.options.data(jobDependencyContext, decodedInput, progress)
      : undefined

    const stepResults: StepResultEntry[] = Array.from({ length: steps.length })

    // Restore previous step results and reconstruct accumulated result
    for (let stepIndex = 0; stepIndex < runStepResults.length; stepIndex++) {
      const entry = runStepResults[stepIndex]
      stepResults[stepIndex] = entry
      if (entry?.data) Object.assign(result, entry.data)
    }

    // @ts-expect-error
    const runOptions: RunOptions = {
      signal,
      result,
      stepResults,
      currentStepIndex: currentStepIndex,
      progress,
      ...rest,
    } satisfies JobRunnerRunOptions

    // Update mutable context references
    progressContext.stepResults = stepResults
    progressContext.options = runOptions

    for (
      let stepIndex = currentStepIndex;
      stepIndex < steps.length;
      stepIndex++
    ) {
      const step = steps[stepIndex]
      const resultSnapshot = Object.freeze(
        Object.assign({}, decodedInput, result),
      )

      try {
        if (signal.aborted) {
          const { reason } = signal
          if (reason instanceof UnrecoverableError) throw reason
          throw new UnrecoverableError('Job cancelled')
        }

        const condition = job.conditions.get(stepIndex)
        if (condition) {
          const shouldRun = await condition({
            context: jobDependencyContext,
            data: jobData,
            input: decodedInput,
            result: resultSnapshot,
            progress,
          })
          if (!shouldRun) {
            const now = Date.now()
            stepResults[stepIndex] = {
              data: null,
              startedAt: now,
              completedAt: now,
              duration: 0,
            }
            continue
          }
        }

        const stepStartedAt = Date.now()

        await this.beforeStep({
          job,
          step,
          stepIndex,
          result,
          options: runOptions,
          stepResults,
        })

        const stepContext = await container.createContext(step.dependencies)
        const stepInput = step.input.decode(resultSnapshot)

        await job.beforeEachHandler?.({
          context: jobDependencyContext,
          data: jobData,
          input: decodedInput,
          result: resultSnapshot,
          progress,
          step,
          stepIndex,
        })

        const handlerReturn = await step.handler(
          stepContext,
          stepInput,
          jobData,
        )

        const produced = step.output.encode(handlerReturn ?? {})
        const stepCompletedAt = Date.now()

        stepResults[stepIndex] = {
          data: produced,
          startedAt: stepStartedAt,
          completedAt: stepCompletedAt,
          duration: stepCompletedAt - stepStartedAt,
        }
        Object.assign(result, produced)

        await job.afterEachHandler?.({
          context: jobDependencyContext,
          data: jobData,
          input: decodedInput,
          result,
          progress,
          step,
          stepIndex,
        })

        await this.afterStep({
          job,
          step,
          stepIndex,
          result,
          stepResult: stepResults[stepIndex],
          stepResults,
          options: runOptions,
        })
      } catch (error) {
        const wrapped = new Error(`Error during step [${stepIndex}]`, {
          cause: error,
        })
        this.logger.error(wrapped)

        const allowRetry = await job.onErrorHandler?.({
          context: jobDependencyContext,
          data: jobData,
          input: decodedInput,
          result: result,
          progress,
          step,
          stepIndex,
          error,
        })

        if (allowRetry === false) {
          throw new UnrecoverableError('Job failed (unrecoverable)')
        }

        throw wrapped
      }
    }

    const finalPayload = await job.returnHandler!({
      context: jobDependencyContext,
      data: jobData,
      input: decodedInput,
      result,
      progress,
    })

    return output.encode(finalPayload)
  }

  protected async beforeStep(
    params: JobRunnerRunBeforeStepParams<RunOptions>,
  ): Promise<void> {
    this.logger.debug(
      {
        job: params.job.name,
        step: params.step.label || params.stepIndex + 1,
        stepIndex: params.stepIndex,
      },
      'Executing job step',
    )
  }

  protected async afterStep(
    params: JobRunnerRunAfterStepParams<RunOptions>,
  ): Promise<void> {
    this.logger.debug(
      {
        job: params.job.name,
        step: params.step.label || params.stepIndex + 1,
        stepIndex: params.stepIndex,
      },
      'Completed job step',
    )
  }
}

export class ApplicationWorkerJobRunner extends JobRunner<
  JobRunnerRunOptions & { queueJob: Job }
> {
  constructor(
    protected runtime: {
      logger: Logger
      container: Container
      lifecycleHooks: LifecycleHooks
    },
  ) {
    super(runtime)
  }

  protected createJobInfo(
    job: AnyJob,
    options: Partial<JobRunnerRunOptions & { queueJob: Job }>,
  ): JobExecutionContext {
    const { queueJob } = options
    return {
      name: job.options.name,
      id: queueJob?.id,
      queue: queueJob?.queueName,
      attempts: queueJob?.attemptsMade,
      stepIndex: options.currentStepIndex,
    }
  }

  protected createSaveProgressFn(
    context: SaveProgressContext<JobRunnerRunOptions & { queueJob: Job }>,
  ): () => Promise<void> {
    return async () => {
      const { job, progress, result, stepResults, options } = context
      if (!options || !stepResults) return

      const { queueJob } = options

      // Find current step index based on completed steps
      let currentStepIndex = 0
      for (let i = 0; i < stepResults.length; i++) {
        if (stepResults[i]) currentStepIndex = i + 1
      }

      // Encode progress before persisting if schema is defined
      const encodedProgress = job.progress
        ? job.progress.encode(progress)
        : progress

      const checkpoint: JobProgressCheckpoint = {
        stepIndex: currentStepIndex,
        result,
        stepResults,
        progress: encodedProgress,
      }

      await queueJob.updateProgress(checkpoint)
    }
  }

  protected async afterStep(
    params: JobRunnerRunAfterStepParams<
      JobRunnerRunOptions & { queueJob: Job }
    >,
  ): Promise<void> {
    await super.afterStep(params)
    const {
      job,
      step,
      result,
      stepResult,
      stepResults,
      stepIndex,
      options: { queueJob, progress },
    } = params
    const nextStepIndex = stepIndex + 1

    // Encode progress before persisting if schema is defined
    const encodedProgress = job.progress
      ? job.progress.encode(progress)
      : progress

    const checkpoint: JobProgressCheckpoint = {
      stepIndex: nextStepIndex,
      stepLabel: step.label,
      result,
      stepResults,
      progress: encodedProgress,
    }

    await Promise.all([
      queueJob.log(
        `Step ${step.label || nextStepIndex} completed in ${(stepResult.duration / 1000).toFixed(3)}s`,
      ),
      queueJob.updateProgress(checkpoint),
    ])
  }
}
