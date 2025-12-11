import type { Container, Logger, LoggingOptions } from '@nmtjs/core'
import type { Job } from 'bullmq'
import { anyAbortSignal } from '@nmtjs/common'
import { Scope } from '@nmtjs/core'

import type { LifecycleHooks } from '../core/hooks.ts'
import type { AnyJob, AnyJobStep } from './job.ts'
import { LifecycleHook } from '../enums.ts'

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
    const signal = anyAbortSignal(
      options.signal,
      this.runtime.lifecycleHooks.createSignal(LifecycleHook.BeforeDispose)
        .signal,
    )
    await using container = this.container.fork(Scope.Global)
    const _context = await container.createContext(job.dependencies)
    const jobContext = Object.freeze(await job.context?.(_context, data))
    const context = { ..._context, $context: jobContext }
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
      const _result = Object.freeze(Object.assign({}, result))
      const condition = step.condition
        ? await step.condition(context, _result)
        : true
      if (!condition) continue
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
        const _stepResult = await step.handler(context, _result, signal)
        stepResult = _stepResult ?? {}
      } catch (cause) {
        throw new Error(`Error during step [${stepIndex}]`, { cause })
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

    result = await job.returnHandler!(
      context,
      Object.freeze(Object.assign({}, result)),
    )

    return output.decode(result)
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
