import { PgliteClient } from '@effect/sql-pglite'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'

import { Notifications } from './notifications.ts'

/** Hints over `@effect/sql-pglite`. */
export const notifications: Layer.Layer<
  Notifications,
  never,
  PgliteClient.PgliteClient
> = Layer.effect(
  Notifications,
  Effect.map(Effect.service(PgliteClient.PgliteClient), (pg) => ({
    listen: (channel) =>
      Effect.map(pg.listen(channel), (queue) => Queue.take(queue)),
  })),
)
