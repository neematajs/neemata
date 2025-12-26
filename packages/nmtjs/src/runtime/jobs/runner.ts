import type { Container, Logger, LoggingOptions } from '@nmtjs/core'
import type { Job } from 'bullmq'
import { anyAbortSignal } from '@nmtjs/common'
import { Scope } from '@nmtjs/core'
import { UnrecoverableError } from 'bullmq'

import type { LifecycleHooks } from '../core/hooks.ts'
import type { AnyJob } from './job.ts'
import type { AnyJobStep } from './step.ts'
import { LifecycleHook } from '../enums.ts'
import { jobAbortSignal } from '../injectables.ts'

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
    this.logger = runtime.logger.child({ $group: JobRunner.name })
  }

  get container() {
    return this.runtime.container
  }

  async runJob<T extends AnyJob>(
    job: T,
    data: any,
    _options?: Partial<RunOptions>,
  ): Promise<T['_']['output']> {
    const {
      signal: _signal,
      result: _result = {},
      stepResults: _stepResults = [] as RunOptions['stepResults'],
      currentStepIndex = 0,
    } = _options ?? {}

    const { input, output, steps } = job

    const result: Record<string, unknown> = { ..._result }
    const decodedInput = input.decode(data)

    const signal = anyAbortSignal(
      _signal,
      this.runtime.lifecycleHooks.createSignal(LifecycleHook.BeforeDispose)
        .signal,
    )
    await using container = this.container.fork(Scope.Global)
    await container.provide(jobAbortSignal, signal)

    const jobDependencyContext = await container.createContext(job.dependencies)
    const jobData = job.options.data
      ? await job.options.data(jobDependencyContext, decodedInput)
      : undefined

    const stepResults = Array.from({ length: steps.length }) as unknown[]

    //@ts-expect-error
    const options: RunOptions = {
      signal,
      result,
      stepResults,
      currentStepIndex: currentStepIndex,
    } satisfies JobRunnerRunOptions

    for (let stepIndex = 0; stepIndex < _stepResults.length; stepIndex++) {
      stepResults[stepIndex] = _stepResults[stepIndex]
    }

    for (
      let stepIndex = currentStepIndex;
      stepIndex < steps.length;
      stepIndex++
    ) {
      if (signal.aborted) {
        const reason = (signal as unknown as { reason?: unknown }).reason
        if (reason instanceof UnrecoverableError) throw reason
        throw new UnrecoverableError('Job cancelled')
      }

      const step = steps[stepIndex]
      const resultSnapshot = Object.freeze(Object.assign({}, result))

      const condition = job.conditions.get(stepIndex)
      if (condition) {
        const shouldRun = await condition({
          context: jobDependencyContext as any,
          data: jobData,
          input: decodedInput as any,
          result: resultSnapshot as any,
        })
        if (!shouldRun) {
          stepResults[stepIndex] = null
          continue
        }
      }

      const stepContext = await container.createContext({
        ...job.dependencies,
        ...step.dependencies,
      })

      const stepInput = step.input.decode(resultSnapshot as any)

      await this.beforeStep({
        job,
        step,
        stepIndex,
        result,
        options,
        stepResults,
      })

      try {
        await job.beforeEachHandler?.({
          context: jobDependencyContext as any,
          data: jobData,
          input: decodedInput as any,
          result: resultSnapshot as any,
          step,
          stepIndex,
        })

        const handlerReturn = await step.handler(
          stepContext as any,
          stepInput as any,
          jobData,
        )

        const produced = step.output.encode((handlerReturn ?? {}) as any)

        stepResults[stepIndex] = produced
        Object.assign(result, produced)

        await job.afterEachHandler?.({
          context: jobDependencyContext as any,
          data: jobData,
          input: decodedInput as any,
          result: Object.freeze(Object.assign({}, result)) as any,
          step,
          stepIndex,
        })

        await this.afterStep({
          job,
          step,
          stepIndex,
          result,
          stepResult: produced,
          stepResults,
          options,
        })
      } catch (error) {
        const allowRetry = await job.onErrorHandler?.({
          context: jobDependencyContext as any,
          data: jobData,
          input: decodedInput as any,
          result: resultSnapshot as any,
          step,
          stepIndex,
          error,
        })

        if (allowRetry === false) {
          throw new UnrecoverableError('Job failed (unrecoverable)')
        }

        const wrapped = new Error(`Error during step [${stepIndex}]`, {
          cause: error,
        })
        this.logger.error(wrapped)
        throw wrapped
      }
    }

    const finalPayload = await job.returnHandler!({
      context: jobDependencyContext as any,
      data: jobData,
      input: decodedInput as any,
      result: Object.freeze(Object.assign({}, result)) as any,
    })

    return output.encode(finalPayload as any)
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
    const {
      step,
      result,
      stepResults,
      stepIndex,
      options: { queueJob },
    } = params
    const nextStepIndex = stepIndex + 1
    await Promise.all([
      queueJob.log('Completed step ' + (step.label || nextStepIndex)),
      queueJob.updateProgress({
        stepIndex: nextStepIndex,
        stepLabel: step.label,
        result,
        stepResults,
      }),
    ])
  }
}
