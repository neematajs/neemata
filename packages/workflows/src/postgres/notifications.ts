import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import type * as SqlError from 'effect/sql/SqlError'
import * as Context from 'effect/Context'

/**
 * `LISTEN`, which `SqlClient` does not have: the one thing the store needs
 * of a driver by name. Without it the store gives no hints and workers find
 * their work by polling alone.
 */
export class Notifications extends Context.Service<
  Notifications,
  {
    /**
     * Listens on `channel` until the scope closes, and gives the effect that
     * waits for the next payload. That effect fails when the listening
     * connection is lost.
     */
    readonly listen: (
      channel: string,
    ) => Effect.Effect<
      Effect.Effect<string, SqlError.SqlError>,
      SqlError.SqlError,
      Scope.Scope
    >
  }
>()('@nmtjs/workflows/postgres/Notifications') {}
