import type { Container, Logger, LoggingOptions } from '@nmtjs/core'
import type { t } from '@nmtjs/type'
import { NeverType } from '@nmtjs/type/never'

import type { AnyJob, AnyJobStep } from './jobs.ts'
import type { LifecycleHooks } from './lifecycle-hooks.ts'
import type { ApplicationRegistry } from './registry.ts'

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
      registry: ApplicationRegistry
      container: Container
      lifecycleHooks: LifecycleHooks
    },
  ) {
    this.logger = runtime.logger.child({ $lable: JobRunner.name })
  }

  get registry() {
    return this.runtime.registry
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
