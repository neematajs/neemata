import { DEFAULT_REQUEST_TIMEOUT_MS } from '@nmtjs/neem/internal/host/lifecycle'
import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export const hostSettings = (env: NodeJS.ProcessEnv) =>
  Config.all({
    requestTimeout: Config.schema(
      Schema.Int.check(Schema.isGreaterThan(0)),
      'NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS',
    ).pipe(Config.withDefault(DEFAULT_REQUEST_TIMEOUT_MS)),
    tracing: Config.Boolean('NEEM_EFFECT_TRACING').pipe(
      Config.withDefault(false),
    ),
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord(env),
    ),
    Effect.mapError(
      (error) => new Error(`Invalid Neem host configuration: ${String(error)}`),
    ),
  )
