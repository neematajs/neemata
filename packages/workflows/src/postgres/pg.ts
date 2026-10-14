import { PgClient } from '@effect/sql-pg'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'

import { Notifications } from './notifications.ts'

/** Hints over `@effect/sql-pg`. Each store holds one connection to listen. */
export const notifications: Layer.Layer<
  Notifications,
  never,
  PgClient.PgClient
> = Layer.effect(
  Notifications,
  Effect.map(Effect.service(PgClient.PgClient), (pg) => ({
    listen: (channel) =>
      Effect.map(pg.listen(channel), (queue) =>
        Effect.map(Queue.take(queue), ({ payload }) => payload),
      ),
  })),
)
