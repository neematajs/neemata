import type * as Effect from 'effect/Effect'
import type { Logger } from 'pino'
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

/** Runs every callback of a host hook; a wait for it can be interrupted. */
export const callHook = <Name extends keyof HostHookMap>(
  hooks: HostHooks,
  logger: Logger,
  name: Name,
  ...args: Parameters<HostHookMap[Name]>
): Effect.Effect<void, Error> => hooks.call(logger, name, ...args)

/** A request's failure: the worker's own error, or why no reply came. */
export function requestError(error: Error | RpcClientError): Error {
  if (error instanceof RpcClientError) {
    return normalizeError(error.reason.cause ?? new Error(error.message))
  }
  return error
}
