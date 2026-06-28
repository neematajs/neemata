import { LifecycleHooks } from '@nmtjs/application'
import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { UnrecoverableError } from 'bullmq'
import { describe, expect, it } from 'vitest'

import type {
  JobRunnerRunOptions,
  SaveProgressContext,
} from '../src/core/runner.ts'
import { createJob, JobRunner } from '../src/index.ts'

class TestJobRunner extends JobRunner {
  protected createSaveProgressFn(
    _context: SaveProgressContext<JobRunnerRunOptions>,
  ) {
    return async () => {}
  }
}

describe('JobRunner', () => {
  it('rejects invalid input without retrying', async () => {
    const job = createJob({
      name: 'invalid-input-job',
      pool: 'default',
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
      attempts: 3,
    }).return(({ input }) => input)
    const logger = createLogger(
      { pinoOptions: { enabled: false } },
      'jobs-test',
    )
    const runner = new TestJobRunner({
      logger,
      container: new Container({ logger }),
      lifecycleHooks: new LifecycleHooks(),
    })

    await expect(runner.runJob(job, { value: 1 })).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
  })
})
