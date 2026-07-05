import type { NeemHealthConfig, NeemProxyConfig } from '../../shared/types.ts'
import type { ManifestConfig } from './manifest.ts'

export type AppliedEnvOverride = {
  source: string
  path: string
  from: string | number | undefined
  to: string | number
}

export type HostConfigEnvOverrides = {
  config: ManifestConfig
  applied: AppliedEnvOverride[]
  warnings: string[]
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
  const warnings: string[] = []

  const proxy = overrideProxy(config.proxy, env, applied, warnings)
  const health = overrideHealth(config.health, env, applied, warnings)

  if (proxy === config.proxy && health === config.health)
    return { config, applied, warnings }

  const next = { ...config }
  if (proxy) next.proxy = proxy
  if (health) next.health = health
  return { config: next, applied, warnings }
}

export function formatAppliedEnvOverride(override: AppliedEnvOverride): string {
  const from = override.from === undefined ? '(unset)' : String(override.from)
  return `Env override ${override.source}: ${override.path} ${from} -> ${override.to}`
}

function overrideProxy(
  proxy: NeemProxyConfig | undefined,
  env: NodeJS.ProcessEnv,
  applied: AppliedEnvOverride[],
  warnings: string[],
): NeemProxyConfig | undefined {
  const port = pickEnv(env, 'NEEM_PROXY_PORT', 'PORT')
  const hostname = pickEnv(env, 'NEEM_PROXY_HOSTNAME')
  const tlsKeyPath = pickEnv(env, 'NEEM_PROXY_TLS_KEY_PATH')
  const tlsCertPath = pickEnv(env, 'NEEM_PROXY_TLS_CERT_PATH')

  if (!proxy) {
    // PORT is a platform-wide convention (PaaS injects it unconditionally),
    // so only neem-specific vars warrant a warning when there is no proxy.
    warnIgnored(warnings, 'no proxy is configured', [
      port?.source === 'NEEM_PROXY_PORT' ? port : undefined,
      hostname,
      tlsKeyPath,
      tlsCertPath,
    ])
    return proxy
  }

  let changed = false
  const next = { ...proxy }

  if (port) {
    const value = parsePort(port.value, port.source)
    if (value !== next.port) {
      applied.push({
        source: port.source,
        path: 'proxy.port',
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
      path: 'proxy.hostname',
      from: next.hostname,
      to: hostname.value,
    })
    next.hostname = hostname.value
    changed = true
  }

  if (tlsKeyPath || tlsCertPath) {
    if (!next.tls && !(tlsKeyPath && tlsCertPath)) {
      throw new Error(
        'Both NEEM_PROXY_TLS_KEY_PATH and NEEM_PROXY_TLS_CERT_PATH must be set to enable proxy TLS at start time',
      )
    }
    const tls = { ...next.tls } as { keyPath: string; certPath: string }
    if (tlsKeyPath && tlsKeyPath.value !== tls.keyPath) {
      applied.push({
        source: tlsKeyPath.source,
        path: 'proxy.tls.keyPath',
        from: tls.keyPath,
        to: tlsKeyPath.value,
      })
      tls.keyPath = tlsKeyPath.value
      changed = true
    }
    if (tlsCertPath && tlsCertPath.value !== tls.certPath) {
      applied.push({
        source: tlsCertPath.source,
        path: 'proxy.tls.certPath',
        from: tls.certPath,
        to: tlsCertPath.value,
      })
      tls.certPath = tlsCertPath.value
      changed = true
    }
    next.tls = tls
  }

  return changed ? next : proxy
}

function overrideHealth(
  health: NeemHealthConfig | undefined,
  env: NodeJS.ProcessEnv,
  applied: AppliedEnvOverride[],
  warnings: string[],
): NeemHealthConfig | undefined {
  const port = pickEnv(env, 'NEEM_HEALTH_PORT')
  const hostname = pickEnv(env, 'NEEM_HEALTH_HOSTNAME')

  if (!health) {
    warnIgnored(warnings, 'no health server is configured', [port, hostname])
    return health
  }

  let changed = false
  const next = { ...health }

  if (port) {
    const value = parsePort(port.value, port.source)
    if (value !== next.port) {
      applied.push({
        source: port.source,
        path: 'health.port',
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
      path: 'health.hostname',
      from: next.hostname,
      to: hostname.value,
    })
    next.hostname = hostname.value
    changed = true
  }

  return changed ? next : health
}

type EnvValue = { source: string; value: string }

function pickEnv(
  env: NodeJS.ProcessEnv,
  ...keys: readonly string[]
): EnvValue | undefined {
  for (const key of keys) {
    // Empty values are common artifacts of compose/CI templating; treat as
    // unset so they don't shadow lower-priority vars or manifest values.
    const value = env[key]
    if (value) return { source: key, value }
  }
  return undefined
}

function parsePort(value: string, source: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `Invalid ${source}="${value}": expected an integer port between 0 and 65535`,
    )
  }
  return port
}

function warnIgnored(
  warnings: string[],
  reason: string,
  values: readonly (EnvValue | undefined)[],
): void {
  const sources = values.filter((value) => value !== undefined)
  if (sources.length === 0) return
  warnings.push(
    `${sources.map((value) => value.source).join(', ')} ignored: ${reason}`,
  )
}
