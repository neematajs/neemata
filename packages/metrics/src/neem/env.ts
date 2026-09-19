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

  // keeps the caller's config object (and its absence) untouched when the
  // environment has nothing to say
  if (!port && !host && !path && !pushUrl && !pushName && !pushInterval)
    return { config, applied, warnings }

  const record = (
    entry: EnvValue | undefined,
    target: string,
    from: string | number | undefined,
    to: string | number | undefined,
  ) => {
    if (!entry || to === undefined || to === from) return
    applied.push({ source: entry.source, path: target, from, to })
  }

  const push = config?.push
  const next: MetricsServerConfig = { ...config }

  if (port) {
    const value = parsePort(port.value, port.source)
    record(port, 'server.port', next.port, value)
    next.port = value
  }

  if (host) {
    record(host, 'server.host', next.host, host.value)
    next.host = host.value
  }

  if (path) {
    record(path, 'server.path', next.path, path.value)
    next.path = path.value
  }

  // Push activates from env alone (NEEM_METRICS_PUSH_URL) so a built image
  // can opt into pushgateway delivery per deployment.
  if (push || pushUrl) {
    const url = pushUrl?.value ?? push?.url
    const name = pushName?.value ?? push?.name
    const interval = pushInterval
      ? parseInterval(pushInterval.value, pushInterval.source)
      : push?.interval

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

    record(pushUrl, 'server.push.url', push?.url, pushUrl?.value)
    record(pushName, 'server.push.name', push?.name, pushName?.value)
    record(pushInterval, 'server.push.interval', push?.interval, interval)

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
