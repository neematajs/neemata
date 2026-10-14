import type { ManifestConfig } from '@nmtjs/neem/internal/manifest/manifest'
import type { NeemServerConfig } from '@nmtjs/neem/internal/shared/types'
import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

export type AppliedEnvOverride = {
  source: string
  path: string
  from: string | number | undefined
  to: string | number
}

export type HostConfigEnvOverrides = {
  config: ManifestConfig
  applied: AppliedEnvOverride[]
}

// The manifest freezes neem.config.ts values at build time, which makes
// deploy-time knobs (ports, hostnames, TLS paths) unconfigurable after the
// image is built. A documented set of env vars is resolved at start so the
// live environment can adjust host networking per deployment.
export function applyHostConfigEnvOverrides(
  config: ManifestConfig,
  env: NodeJS.ProcessEnv,
): HostConfigEnvOverrides {
  const applied: AppliedEnvOverride[] = []
  const server = overrideServer(config.server, env, applied)
  if (server === config.server) return { config, applied }
  return { config: { ...config, server }, applied }
}

export function formatAppliedEnvOverride(override: AppliedEnvOverride): string {
  const from = override.from === undefined ? '(unset)' : String(override.from)
  return `Env override ${override.source}: ${override.path} ${from} -> ${override.to}`
}

function overrideServer(
  server: NeemServerConfig | undefined,
  env: NodeJS.ProcessEnv,
  applied: AppliedEnvOverride[],
): NeemServerConfig | undefined {
  const port = pickEnv(env, 'NEEM_SERVER_PORT', 'PORT')
  const hostname = pickEnv(env, 'NEEM_SERVER_HOSTNAME')
  const tlsKeyPath = pickEnv(env, 'NEEM_SERVER_TLS_KEY_PATH')
  const tlsCertPath = pickEnv(env, 'NEEM_SERVER_TLS_CERT_PATH')

  let changed = false
  const next: NeemServerConfig = { ...server }

  if (port) {
    const value = parsePort(port.value, port.source)
    if (value !== next.port) {
      applied.push({
        source: port.source,
        path: 'server.port',
        from: next.port,
        to: value,
      })
      next.port = value
      changed = true
    }
  }

  if (hostname && hostname.value !== next.hostname) {
    applied.push({
      source: hostname.source,
      path: 'server.hostname',
      from: next.hostname,
      to: hostname.value,
    })
    next.hostname = hostname.value
    changed = true
  }

  if (tlsKeyPath || tlsCertPath) {
    if (!next.tls && !(tlsKeyPath && tlsCertPath)) {
      throw new Error(
        'Both NEEM_SERVER_TLS_KEY_PATH and NEEM_SERVER_TLS_CERT_PATH must be set to enable server TLS at start time',
      )
    }
    const tls = { ...next.tls } as { keyPath: string; certPath: string }
    if (tlsKeyPath && tlsKeyPath.value !== tls.keyPath) {
      applied.push({
        source: tlsKeyPath.source,
        path: 'server.tls.keyPath',
        from: tls.keyPath,
        to: tlsKeyPath.value,
      })
      tls.keyPath = tlsKeyPath.value
      changed = true
    }
    if (tlsCertPath && tlsCertPath.value !== tls.certPath) {
      applied.push({
        source: tlsCertPath.source,
        path: 'server.tls.certPath',
        from: tls.certPath,
        to: tlsCertPath.value,
      })
      tls.certPath = tlsCertPath.value
      changed = true
    }
    next.tls = tls
  }

  return changed ? next : server
}

type EnvValue = { source: string; value: string }

function pickEnv(
  env: NodeJS.ProcessEnv,
  ...keys: readonly string[]
): EnvValue | undefined {
  for (const key of keys) {
    // Empty values are common artifacts of compose/CI templating; treat as
    // unset so they don't shadow lower-priority vars or manifest values.
    const value = Effect.runSync(
      Config.String(key).pipe(
        Config.option,
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(env),
        ),
      ),
    )
    if (Option.isSome(value)) return { source: key, value: value.value }
  }
  return undefined
}

function parsePort(value: string, source: string): number {
  return Effect.runSync(
    Config.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
      source,
    ).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({ [source]: value }),
      ),
      Effect.mapError(
        () =>
          new Error(
            `Invalid ${source}="${value}": expected an integer port between 0 and 65535`,
          ),
      ),
    ),
  )
}
