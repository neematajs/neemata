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

type EnvValue = { source: string; value: string }

type Overridden<T> = {
  value: T
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
  const proxy = overrideProxy(config.proxy, env)
  const health = overrideHealth(config.health, env)
  const applied = [...proxy.applied, ...health.applied]
  const warnings = [...proxy.warnings, ...health.warnings]

  if (applied.length === 0) return { config, applied, warnings }

  const next = { ...config }
  if (proxy.value) next.proxy = proxy.value
  if (health.value) next.health = health.value
  return { config: next, applied, warnings }
}

export function formatAppliedEnvOverride(override: AppliedEnvOverride): string {
  const from = override.from === undefined ? '(unset)' : String(override.from)
  return `Env override ${override.source}: ${override.path} ${from} -> ${override.to}`
}

function overrideProxy(
  proxy: NeemProxyConfig | undefined,
  env: NodeJS.ProcessEnv,
): Overridden<NeemProxyConfig | undefined> {
  const port = pickEnv(env, 'NEEM_PROXY_PORT', 'PORT')
  const hostname = pickEnv(env, 'NEEM_PROXY_HOSTNAME')
  const keyPath = pickEnv(env, 'NEEM_PROXY_TLS_KEY_PATH')
  const certPath = pickEnv(env, 'NEEM_PROXY_TLS_CERT_PATH')

  if (!proxy) {
    // PORT is a platform-wide convention (PaaS injects it unconditionally),
    // so only neem-specific vars warrant a warning when there is no proxy.
    const ignored = [
      port?.source === 'NEEM_PROXY_PORT' ? port : undefined,
      hostname,
      keyPath,
      certPath,
    ]
    return {
      value: proxy,
      applied: [],
      warnings: warnIgnored('no proxy is configured', ignored),
    }
  }

  const next = { ...proxy }
  const applied = overrideEndpoint(next, 'proxy', port, hostname)
  applied.push(...overrideTls(next, keyPath, certPath))

  return { value: applied.length > 0 ? next : proxy, applied, warnings: [] }
}

function overrideHealth(
  health: NeemHealthConfig | undefined,
  env: NodeJS.ProcessEnv,
): Overridden<NeemHealthConfig | undefined> {
  const port = pickEnv(env, 'NEEM_HEALTH_PORT')
  const hostname = pickEnv(env, 'NEEM_HEALTH_HOSTNAME')

  if (!health) {
    return {
      value: health,
      applied: [],
      warnings: warnIgnored('no health server is configured', [port, hostname]),
    }
  }

  const next = { ...health }
  const applied = overrideEndpoint(next, 'health', port, hostname)

  return { value: applied.length > 0 ? next : health, applied, warnings: [] }
}

// The proxy and the health server expose the same listen knobs; `endpoint` is
// the caller's own copy, so overwriting it in place is safe.
function overrideEndpoint(
  endpoint: { hostname?: string; port: number },
  path: string,
  port: EnvValue | undefined,
  hostname: EnvValue | undefined,
): AppliedEnvOverride[] {
  const applied: AppliedEnvOverride[] = []

  if (port) {
    const value = parsePort(port.value, port.source)
    if (value !== endpoint.port) {
      applied.push({
        source: port.source,
        path: `${path}.port`,
        from: endpoint.port,
        to: value,
      })
      endpoint.port = value
    }
  }

  if (hostname && hostname.value !== endpoint.hostname) {
    applied.push({
      source: hostname.source,
      path: `${path}.hostname`,
      from: endpoint.hostname,
      to: hostname.value,
    })
    endpoint.hostname = hostname.value
  }

  return applied
}

function overrideTls(
  proxy: NeemProxyConfig,
  keyPath: EnvValue | undefined,
  certPath: EnvValue | undefined,
): AppliedEnvOverride[] {
  if (!keyPath && !certPath) return []

  const current = proxy.tls
  const key = keyPath?.value ?? current?.keyPath
  const cert = certPath?.value ?? current?.certPath
  if (key === undefined || cert === undefined) {
    throw new Error(
      'Both NEEM_PROXY_TLS_KEY_PATH and NEEM_PROXY_TLS_CERT_PATH must be set to enable proxy TLS at start time',
    )
  }

  const applied: AppliedEnvOverride[] = []
  if (keyPath && key !== current?.keyPath) {
    applied.push({
      source: keyPath.source,
      path: 'proxy.tls.keyPath',
      from: current?.keyPath,
      to: key,
    })
  }
  if (certPath && cert !== current?.certPath) {
    applied.push({
      source: certPath.source,
      path: 'proxy.tls.certPath',
      from: current?.certPath,
      to: cert,
    })
  }
  proxy.tls = { keyPath: key, certPath: cert }

  return applied
}

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
  reason: string,
  values: readonly (EnvValue | undefined)[],
): string[] {
  const sources: string[] = []
  for (const value of values) {
    if (value) sources.push(value.source)
  }
  if (sources.length === 0) return []

  return [`${sources.join(', ')} ignored: ${reason}`]
}
