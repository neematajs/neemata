import type {
  ApplicationRegistry,
  JobRunnerRunAfterStepParams,
  JobRunnerRunOptions,
  LifecycleHooks,
} from '@nmtjs/application'
import type { Container, Logger } from '@nmtjs/core'
import type { Job } from 'bullmq'
import { JobRunner } from '@nmtjs/application'

export class ApplicationWorkerJobRunner extends JobRunner<
  JobRunnerRunOptions & { queueJob: Job }
> {
  constructor(
    protected runtime: {
      logger: Logger
      registry: ApplicationRegistry
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
