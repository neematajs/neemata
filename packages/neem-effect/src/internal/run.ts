import { OperationAbortedError } from '@nmtjs/neem/internal/host/lifecycle'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

/**
 * Runs an Effect for a Promise caller. Interruption means a stop took over the
 * operation, which Neem callers tell apart from failure by
 * `OperationAbortedError`.
 */
export async function runPromise<A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  if (Cause.hasInterruptsOnly(exit.cause)) throw new OperationAbortedError()
  throw Cause.squash(exit.cause)
}
