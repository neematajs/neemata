import type { Container, Logger, LoggingOptions } from '@nmtjs/core'
import type { t } from '@nmtjs/type'
import type { Job } from 'bullmq'
import { NeverType } from '@nmtjs/type/never'

import type { LifecycleHooks } from '../core/hooks.ts'
import type { AnyJob } from './job.ts'
import type { AnyJobStep } from './step.ts'

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
        stepResult = await this.runStep(
          step,
          stepIndex === 0 ? data : result,
          options.signal,
        )
      } catch (error) {
        console.dir({ stepIndex, data, result })
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

      console.log({ job: job.name, step: stepIndex, stepResult, result })
    }
    if (output) result = output.decode(result)
    return result
  }

  async runStep<T extends AnyJobStep>(
    step: T,
    data: t.infer.decode.input<T['input']>,
    signal: AbortSignal,
  ) {
    const { dependencies, handler, input, output } = step
    if (input instanceof NeverType === false) {
      data = input.decode(data)
    }
    const context = await this.container.createContext(dependencies)
    const result = await handler(context, data, signal)
    return output.decode(result)
  }

  protected async beforeStep(
    params: JobRunnerRunBeforeStepParams<RunOptions>,
  ): Promise<void> {}

  protected async afterStep(
    params: JobRunnerRunAfterStepParams<RunOptions>,
  ): Promise<void> {}
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
