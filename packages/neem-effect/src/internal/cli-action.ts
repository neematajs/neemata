import { normalizeError } from '@nmtjs/neem/internal/utils'
import * as Effect from 'effect/Effect'

/**
 * Interrupting the CLI aborts the shared Promise action, then waits for its
 * cleanup. A cleanup rejection remains a failure; it must not become a clean
 * signal exit merely because the CLI fiber was interrupted first.
 */
export const cliAction = (
  action: (signal: AbortSignal) => Promise<void>,
): Effect.Effect<void, Error> =>
  Effect.suspend(() => {
    let completion: Promise<void> | undefined
    return Effect.tryPromise({
      try: (signal) => (completion = action(signal)),
      catch: normalizeError,
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.promise(async () => {
          await completion
        }),
      ),
    )
  })
