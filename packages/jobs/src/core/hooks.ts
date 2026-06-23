import type { MaybePromise } from '@nmtjs/common'

export type JobsStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'cancelled'
  | 'unknown'

export type JobsHookEvent = {
  id: string
  jobName: string
  queueName: string
  status: JobsStatus
  attempt: number
  input?: unknown
  output?: unknown
  checkpoint?: unknown
  error?: unknown
  createdAt?: number
  startedAt?: number
  completedAt?: number
  updatedAt: number
}

export type JobsHookRemovedEvent = {
  id: string
  jobName: string
  queueName: string
  removedAt: number
}

export type JobsLifecycleHooks = {
  added?: (event: JobsHookEvent) => MaybePromise<void>
  updated?: (event: JobsHookEvent) => MaybePromise<void>
  removed?: (event: JobsHookRemovedEvent) => MaybePromise<void>
}

export type JobsHookName = keyof JobsLifecycleHooks

export type JobsHookEventFor<Name extends JobsHookName> = Name extends 'removed'
  ? JobsHookRemovedEvent
  : JobsHookEvent

export type JobsHookErrorHandler<Name extends JobsHookName = JobsHookName> = (
  error: unknown,
  event: JobsHookEventFor<Name>,
  hook: Name,
) => MaybePromise<void>

export async function callJobsHook<const Name extends JobsHookName>(
  hooks: JobsLifecycleHooks,
  name: Name,
  event: JobsHookEventFor<Name>,
  onError?: JobsHookErrorHandler<Name>,
): Promise<void> {
  try {
    await (
      hooks[name] as ((event: JobsHookEventFor<Name>) => unknown) | undefined
    )?.(event)
  } catch (error) {
    try {
      await onError?.(error, event, name)
    } catch {
      // Hook error handlers must not affect queue operations.
    }
  }
}
