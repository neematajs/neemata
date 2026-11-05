import type { Logger } from 'pino'
import * as Effect from 'effect/Effect'
import { RpcClientError } from 'effect/rpc/RpcClientError'

import type { NeemHostHookMap as HostHookMap } from '../shared/types.ts'
import type { HostHooks } from './hooks.ts'
import type { RuntimeSnapshot } from './manifest/snapshot.ts'
import type { WorkerRegistry } from './transport.ts'
import { resolveLifecycle } from './host/lifecycle.ts'
import { normalizeError } from './utils.ts'

export type ThreadLifecycleEvent = {
  type: 'thread-started' | 'thread-stopped'
  runtimeName: string
  threadId: string
}

/** What every runtime, thread and runner of one host shares. */
export type HostContext = {
  readonly hooks: HostHooks
  readonly registry: WorkerRegistry
  readonly onThreadEvent?: (event: ThreadLifecycleEvent) => void
}

export const lifecycleOf = (snapshot: RuntimeSnapshot) =>
  resolveLifecycle(snapshot.config.lifecycle)

export const hookCall = (
  hooks: HostHooks,
  snapshot: RuntimeSnapshot,
  logger: Logger = snapshot.logger,
): HookCall => ({ hooks, logger, timeout: lifecycleOf(snapshot).hookTimeout })

export type HookCall = {
  hooks: HostHooks
  logger: Logger
  /** Bounds the whole dispatch, not each callback. */
  timeout: number
}

/**
 * Runs every callback of a host hook within `timeout`. A hook that runs out
 * fails like a hook that threw; its callbacks are not cancelled, only no
 * longer waited for, so a hung plugin cannot stall a start, a recovery or a
 * stop.
 */
export const callHook = <Name extends keyof HostHookMap>(
  { hooks, logger, timeout }: HookCall,
  name: Name,
  ...args: Parameters<HostHookMap[Name]>
): Effect.Effect<void, Error> =>
  hooks.call(logger, name, ...args).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new Error(`Neem hook [${name}] did not finish within ${timeout}ms`),
        ),
    }),
  )

/** A request's failure: the worker's own error, or why no reply came. */
export function requestError(error: Error | RpcClientError): Error {
  if (error instanceof RpcClientError) {
    return normalizeError(error.reason.cause ?? new Error(error.message))
  }
  return error
}
