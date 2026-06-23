import { describe, expect, it, vi } from 'vitest'

import { callJobsHook } from '../src/core/hooks.ts'

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
