import { describe, expect, it, vi } from 'vitest'
import type { Job as BullJob } from 'bullmq'

import { callJobsHook } from '../src/core/hooks.ts'
import { JobManager } from '../src/manager.ts'

describe('callJobsHook', () => {
  it('does not reject when the hook error handler throws', async () => {
    const event = {
      id: 'job-1',
      jobName: 'email',
      queueName: 'job.email',
      status: 'pending' as const,
      attempt: 0,
      updatedAt: Date.now(),
    }
    const onError = vi.fn(() => {
      throw new Error('audit sink down')
    })

    await expect(
      callJobsHook(
        {
          added: () => {
            throw new Error('hook failed')
          },
        },
        'added',
        event,
        onError,
      ),
    ).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), event, 'added')
  })
})

describe('JobManager hooks', () => {
  it('emits cancelled for queue jobs failed by cancellation', async () => {
    const updated = vi.fn()
    const manager = new JobManager({} as never, [], { updated })
    const bullJob = {
      id: 'job-1',
      name: 'email',
      queueName: 'job.email',
      data: {},
      returnvalue: null,
      progress: {},
      priority: 0,
      attemptsMade: 1,
      processedOn: Date.now(),
      finishedOn: Date.now(),
      failedReason: 'Job cancelled',
      stacktrace: [],
      getState: async () => 'failed',
    } as unknown as BullJob

    await manager.emitUpdated(bullJob)

    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    )
  })
})
