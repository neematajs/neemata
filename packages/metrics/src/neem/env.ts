import type { MetricsServerConfig } from '../server.ts'

export type AppliedMetricsEnvOverride = {
  source: string
  path: string
  from: string | number | undefined
  to: string | number
}

export type MetricsServerEnvOverrides = {
  config: MetricsServerConfig | undefined
  applied: AppliedMetricsEnvOverride[]
  warnings: string[]
}

// Plugin options are baked into the neem manifest at build time, but the
// plugin factory runs at start in the deploy environment — so the metrics
// server/push knobs are resolvable from env vars per deployment.
export function applyMetricsServerEnvOverrides(
  config: MetricsServerConfig | undefined,
  env: NodeJS.ProcessEnv,
): MetricsServerEnvOverrides {
  const applied: AppliedMetricsEnvOverride[] = []
  const warnings: string[] = []

  const port = pickEnv(env, 'NEEM_METRICS_PORT')
  const host = pickEnv(env, 'NEEM_METRICS_HOST')
  const path = pickEnv(env, 'NEEM_METRICS_PATH')
  const pushUrl = pickEnv(env, 'NEEM_METRICS_PUSH_URL')
  const pushName = pickEnv(env, 'NEEM_METRICS_PUSH_NAME')
  const pushInterval = pickEnv(env, 'NEEM_METRICS_PUSH_INTERVAL')

  if (!port && !host && !path && !pushUrl && !pushName && !pushInterval)
    return { config, applied, warnings }

  const next: MetricsServerConfig = { ...config }

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
    }
  }

  if (host && host.value !== next.host) {
    applied.push({
      source: host.source,
      path: 'server.host',
      from: next.host,
      to: host.value,
    })
    next.host = host.value
  }

  if (path && path.value !== next.path) {
    applied.push({
      source: path.source,
      path: 'server.path',
      from: next.path,
      to: path.value,
    })
    next.path = path.value
  }

  // Push activates from env alone (NEEM_METRICS_PUSH_URL) so a built image
  // can opt into pushgateway delivery per deployment.
  if (config?.push || pushUrl) {
    const url = pushUrl?.value ?? config?.push?.url
    const name = pushName?.value ?? config?.push?.name
    const interval = pushInterval
      ? parseInterval(pushInterval.value, pushInterval.source)
      : config?.push?.interval

    if (!name) {
      throw new Error(
        'Metrics push requires a job name: set NEEM_METRICS_PUSH_NAME or configure push.name',
      )
    }
    if (interval === undefined) {
      throw new Error(
        'Metrics push requires an interval: set NEEM_METRICS_PUSH_INTERVAL (milliseconds) or configure push.interval',
      )
    }

    if (pushUrl && pushUrl.value !== config?.push?.url) {
      applied.push({
        source: pushUrl.source,
        path: 'server.push.url',
        from: config?.push?.url,
        to: pushUrl.value,
      })
    }
    if (pushName && pushName.value !== config?.push?.name) {
      applied.push({
        source: pushName.source,
        path: 'server.push.name',
        from: config?.push?.name,
        to: pushName.value,
      })
    }
    if (pushInterval && interval !== config?.push?.interval) {
      applied.push({
        source: pushInterval.source,
        path: 'server.push.interval',
        from: config?.push?.interval,
        to: interval,
      })
    }

    next.push = url === undefined ? { name, interval } : { url, name, interval }
  } else if (pushName || pushInterval) {
    const sources = [pushName, pushInterval]
      .filter((value) => value !== undefined)
      .map((value) => value.source)
    warnings.push(
      `${sources.join(', ')} ignored: metrics push is not enabled (set NEEM_METRICS_PUSH_URL or configure push)`,
    )
  }

  return { config: next, applied, warnings }
}

export function formatAppliedMetricsEnvOverride(
  override: AppliedMetricsEnvOverride,
): string {
  const from = override.from === undefined ? '(unset)' : String(override.from)
  return `Env override ${override.source}: ${override.path} ${from} -> ${override.to}`
}

type EnvValue = { source: string; value: string }

function pickEnv(env: NodeJS.ProcessEnv, key: string): EnvValue | undefined {
  // Empty values are common artifacts of compose/CI templating; treat as
  // unset so they don't shadow configured values.
  const value = env[key]
  return value ? { source: key, value } : undefined
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

function parseInterval(value: string, source: string): number {
  const interval = Number(value)
  if (!Number.isInteger(interval) || interval <= 0) {
    throw new Error(
      `Invalid ${source}="${value}": expected a positive integer of milliseconds`,
    )
  }
  return interval
}
