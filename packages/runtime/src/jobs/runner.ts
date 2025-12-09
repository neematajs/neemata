import type { Container, Logger, LoggingOptions } from '@nmtjs/core'
import type { Job } from 'bullmq'

import type { LifecycleHooks } from '../core/hooks.ts'
import type { AnyJob, AnyJobStep } from './job.ts'

export type JobRunnerOptions = { logging?: LoggingOptions }

export interface JobRunnerRunOptions {
  signal: AbortSignal
  result: Record<string, unknown>
  stepResults: any[]
  currentStepIndex: number
}

export interface JobRunnerRunBeforeStepParams<
  Options extends JobRunnerRunOptions,
> {
  job: AnyJob
  step: AnyJobStep
  stepIndex: number
  result: any
  stepResults: any[]
  options: Options
}

export interface JobRunnerRunAfterStepParams<
  Options extends JobRunnerRunOptions,
> extends JobRunnerRunBeforeStepParams<Options> {
  stepResult: any
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
    this.logger = runtime.logger.child({ $lable: JobRunner.name })
  }

  get container() {
    return this.runtime.container
  }

  async runJob<T extends AnyJob>(
    job: T,
    data: any,
    options = {
      signal: new AbortController().signal,
      result: {},
      stepResults: [] as RunOptions['stepResults'],
      currentStepIndex: 0,
    } as RunOptions,
  ): Promise<T['_']['output']> {
    const { input, output, steps } = job
    let result: Record<string, unknown> = { ...options.result }
    if (input) data = input.decode(data)
    const context = await this.container.createContext(job.dependencies)
    const jobContext = await job.context?.(context, data)
    const stepResults = Array.from({ length: steps.length })
    for (
      let stepIndex = 0;
      stepIndex < options.stepResults.length;
      stepIndex++
    ) {
      stepResults[stepIndex] = options.stepResults[stepIndex]
    }

    for (
      let stepIndex = options.currentStepIndex;
      stepIndex < steps.length;
      stepIndex++
    ) {
      const step = steps[stepIndex]
      await this.beforeStep({
        job,
        step,
        stepIndex,
        result,
        options,
        stepResults,
      })
      let stepResult: unknown
      try {
        const result = await step.handler(context, jobContext, options.signal)
        stepResult = result ?? {}
      } catch (error) {
        throw new Error(`Error during step [${stepIndex}]`, {
          cause: error as Error,
        })
      }
      stepResults[stepIndex] = stepResult
      Object.assign(result, stepResult)
      await this.afterStep({
        job,
        step,
        stepIndex,
        result,
        stepResult,
        stepResults,
        options,
      })
    }
    result = await job.returnHandler!(result)
    return output.decode(result)
  }

  async runStep(
    step: AnyJobStep,
    context: any,
    jobContext: any,
    signal: AbortSignal,
  ) {
    const { handler } = step
    return handler(context, jobContext, signal)
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

  protected async afterStep(
    params: JobRunnerRunAfterStepParams<
      JobRunnerRunOptions & { queueJob: Job }
    >,
  ): Promise<void> {
    const { step, options, result, stepResults, stepIndex } = params
    const nextStepIndex = stepIndex + 1
    await Promise.all([
      options.queueJob.log('Completed step ' + (step.label || nextStepIndex)),
      options.queueJob.updateProgress({
        result,
        stepResults,
        stepIndex: nextStepIndex,
      }),
    ])
  }
}
