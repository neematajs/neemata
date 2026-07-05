import { describe, expect, it } from 'vitest'

import type { MetricsServerConfig } from '../src/server.ts'
import {
  applyMetricsServerEnvOverrides,
  formatAppliedMetricsEnvOverride,
} from '../src/neem/env.ts'

describe('@nmtjs/metrics/neem env overrides', () => {
  it('returns the config untouched when no override vars are set', () => {
    const config: MetricsServerConfig = { port: 9187 }
    const result = applyMetricsServerEnvOverrides(config, {})

    expect(result.config).toBe(config)
    expect(result.applied).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('overrides server port, host, and path', () => {
    const result = applyMetricsServerEnvOverrides(
      { port: 9187, host: '0.0.0.0', path: '/metrics' },
      {
        NEEM_METRICS_PORT: '9999',
        NEEM_METRICS_HOST: '127.0.0.1',
        NEEM_METRICS_PATH: '/custom',
      },
    )

    expect(result.config).toEqual({
      port: 9999,
      host: '127.0.0.1',
      path: '/custom',
    })
    expect(result.applied).toHaveLength(3)
  })

  it('creates the server config from env when none was configured', () => {
    const result = applyMetricsServerEnvOverrides(undefined, {
      NEEM_METRICS_PORT: '9999',
    })

    expect(result.config).toEqual({ port: 9999 })
  })

  it('enables push from env vars alone', () => {
    const result = applyMetricsServerEnvOverrides(undefined, {
      NEEM_METRICS_PUSH_URL: 'http://gateway:9091',
      NEEM_METRICS_PUSH_NAME: 'api',
      NEEM_METRICS_PUSH_INTERVAL: '15000',
    })

    expect(result.config?.push).toEqual({
      url: 'http://gateway:9091',
      name: 'api',
      interval: 15000,
    })
  })

  it('overrides individual push fields of a configured push', () => {
    const result = applyMetricsServerEnvOverrides(
      { push: { url: 'http://old:9091', name: 'api', interval: 15000 } },
      { NEEM_METRICS_PUSH_URL: 'http://new:9091' },
    )

    expect(result.config?.push).toEqual({
      url: 'http://new:9091',
      name: 'api',
      interval: 15000,
    })
    expect(result.applied).toEqual([
      {
        source: 'NEEM_METRICS_PUSH_URL',
        path: 'server.push.url',
        from: 'http://old:9091',
        to: 'http://new:9091',
      },
    ])
  })

  it('requires a job name when enabling push from env', () => {
    expect(() =>
      applyMetricsServerEnvOverrides(undefined, {
        NEEM_METRICS_PUSH_URL: 'http://gateway:9091',
        NEEM_METRICS_PUSH_INTERVAL: '15000',
      }),
    ).toThrow(/NEEM_METRICS_PUSH_NAME/)
  })

  it('requires an interval when enabling push from env', () => {
    expect(() =>
      applyMetricsServerEnvOverrides(undefined, {
        NEEM_METRICS_PUSH_URL: 'http://gateway:9091',
        NEEM_METRICS_PUSH_NAME: 'api',
      }),
    ).toThrow(/NEEM_METRICS_PUSH_INTERVAL/)
  })

  it('rejects invalid port and interval values', () => {
    expect(() =>
      applyMetricsServerEnvOverrides(undefined, { NEEM_METRICS_PORT: 'nope' }),
    ).toThrow(/Invalid NEEM_METRICS_PORT="nope"/)
    expect(() =>
      applyMetricsServerEnvOverrides(
        { push: { name: 'api', interval: 15000 } },
        { NEEM_METRICS_PUSH_INTERVAL: '-5' },
      ),
    ).toThrow(/Invalid NEEM_METRICS_PUSH_INTERVAL="-5"/)
  })

  it('warns about push field vars when push is not enabled', () => {
    const result = applyMetricsServerEnvOverrides(undefined, {
      NEEM_METRICS_PUSH_NAME: 'api',
      NEEM_METRICS_PUSH_INTERVAL: '15000',
    })

    expect(result.config?.push).toBeUndefined()
    expect(result.warnings).toEqual([
      'NEEM_METRICS_PUSH_NAME, NEEM_METRICS_PUSH_INTERVAL ignored: metrics push is not enabled (set NEEM_METRICS_PUSH_URL or configure push)',
    ])
  })

  it('treats empty values as unset', () => {
    const config: MetricsServerConfig = { port: 9187 }
    const result = applyMetricsServerEnvOverrides(config, {
      NEEM_METRICS_PORT: '',
      NEEM_METRICS_PUSH_URL: '',
    })

    expect(result.config).toBe(config)
    expect(result.applied).toEqual([])
  })

  it('formats applied overrides for logging', () => {
    expect(
      formatAppliedMetricsEnvOverride({
        source: 'NEEM_METRICS_PUSH_URL',
        path: 'server.push.url',
        from: undefined,
        to: 'http://gateway:9091',
      }),
    ).toBe(
      'Env override NEEM_METRICS_PUSH_URL: server.push.url (unset) -> http://gateway:9091',
    )
  })
})
