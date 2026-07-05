import { describe, expect, it } from 'vitest'

import type { ManifestConfig } from '../../src/internal/manifest/manifest.ts'
import {
  applyHostConfigEnvOverrides,
  formatAppliedEnvOverride,
} from '../../src/internal/manifest/env-overrides.ts'

const baseConfig: ManifestConfig = {
  proxy: { hostname: '127.0.0.1', port: 8000 },
  health: { hostname: '127.0.0.1', port: 8081 },
  runtimes: {},
}

describe('Neem host config env overrides', () => {
  it('returns the config untouched when no override vars are set', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {})

    expect(result.config).toBe(baseConfig)
    expect(result.applied).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('overrides proxy port and hostname from NEEM_PROXY_* vars', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_PROXY_PORT: '3000',
      NEEM_PROXY_HOSTNAME: '0.0.0.0',
    })

    expect(result.config.proxy).toEqual({ hostname: '0.0.0.0', port: 3000 })
    expect(result.applied).toEqual([
      {
        source: 'NEEM_PROXY_PORT',
        path: 'proxy.port',
        from: 8000,
        to: 3000,
      },
      {
        source: 'NEEM_PROXY_HOSTNAME',
        path: 'proxy.hostname',
        from: '127.0.0.1',
        to: '0.0.0.0',
      },
    ])
  })

  it('falls back to the platform PORT convention for the proxy port', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, { PORT: '5000' })

    expect(result.config.proxy?.port).toBe(5000)
    expect(result.applied).toEqual([
      { source: 'PORT', path: 'proxy.port', from: 8000, to: 5000 },
    ])
  })

  it('prefers NEEM_PROXY_PORT over PORT', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_PROXY_PORT: '3000',
      PORT: '5000',
    })

    expect(result.config.proxy?.port).toBe(3000)
  })

  it('overrides health port and hostname from NEEM_HEALTH_* vars', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_HEALTH_PORT: '9000',
      NEEM_HEALTH_HOSTNAME: '::',
    })

    expect(result.config.health).toEqual({ hostname: '::', port: 9000 })
  })

  it('does not mutate the input config', () => {
    applyHostConfigEnvOverrides(baseConfig, {
      NEEM_PROXY_PORT: '3000',
      NEEM_HEALTH_PORT: '9000',
    })

    expect(baseConfig.proxy?.port).toBe(8000)
    expect(baseConfig.health?.port).toBe(8081)
  })

  it('enables proxy TLS when both path vars are set', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_PROXY_TLS_KEY_PATH: '/secrets/key.pem',
      NEEM_PROXY_TLS_CERT_PATH: '/secrets/cert.pem',
    })

    expect(result.config.proxy?.tls).toEqual({
      keyPath: '/secrets/key.pem',
      certPath: '/secrets/cert.pem',
    })
  })

  it('overrides a single TLS path when TLS is already configured', () => {
    const config: ManifestConfig = {
      ...baseConfig,
      proxy: {
        hostname: '127.0.0.1',
        port: 8000,
        tls: { keyPath: '/old/key.pem', certPath: '/old/cert.pem' },
      },
    }
    const result = applyHostConfigEnvOverrides(config, {
      NEEM_PROXY_TLS_KEY_PATH: '/new/key.pem',
    })

    expect(result.config.proxy?.tls).toEqual({
      keyPath: '/new/key.pem',
      certPath: '/old/cert.pem',
    })
  })

  it('rejects enabling TLS with only one of the path vars', () => {
    expect(() =>
      applyHostConfigEnvOverrides(baseConfig, {
        NEEM_PROXY_TLS_KEY_PATH: '/secrets/key.pem',
      }),
    ).toThrow(/Both NEEM_PROXY_TLS_KEY_PATH and NEEM_PROXY_TLS_CERT_PATH/)
  })

  it('rejects non-numeric ports', () => {
    expect(() =>
      applyHostConfigEnvOverrides(baseConfig, { NEEM_PROXY_PORT: 'nope' }),
    ).toThrow(/Invalid NEEM_PROXY_PORT="nope"/)
    expect(() =>
      applyHostConfigEnvOverrides(baseConfig, { NEEM_HEALTH_PORT: '70000' }),
    ).toThrow(/Invalid NEEM_HEALTH_PORT="70000"/)
  })

  it('treats empty values as unset', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_PROXY_PORT: '',
      PORT: '5000',
      NEEM_PROXY_HOSTNAME: '',
    })

    expect(result.config.proxy).toEqual({ hostname: '127.0.0.1', port: 5000 })
  })

  it('skips no-op overrides matching the manifest value', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_PROXY_PORT: '8000',
    })

    expect(result.config).toBe(baseConfig)
    expect(result.applied).toEqual([])
  })

  it('warns about neem-specific vars when the target is not configured', () => {
    const config: ManifestConfig = { runtimes: {} }
    const result = applyHostConfigEnvOverrides(config, {
      NEEM_PROXY_PORT: '3000',
      NEEM_HEALTH_PORT: '9000',
      PORT: '5000',
    })

    expect(result.config).toBe(config)
    expect(result.warnings).toEqual([
      'NEEM_PROXY_PORT ignored: no proxy is configured',
      'NEEM_HEALTH_PORT ignored: no health server is configured',
    ])
  })

  it('stays silent about a stray PORT when no proxy is configured', () => {
    const config: ManifestConfig = { runtimes: {} }
    const result = applyHostConfigEnvOverrides(config, { PORT: '5000' })

    expect(result.warnings).toEqual([])
  })

  it('formats applied overrides for logging', () => {
    expect(
      formatAppliedEnvOverride({
        source: 'NEEM_PROXY_PORT',
        path: 'proxy.port',
        from: 8000,
        to: 3000,
      }),
    ).toBe('Env override NEEM_PROXY_PORT: proxy.port 8000 -> 3000')
    expect(
      formatAppliedEnvOverride({
        source: 'NEEM_PROXY_TLS_KEY_PATH',
        path: 'proxy.tls.keyPath',
        from: undefined,
        to: '/secrets/key.pem',
      }),
    ).toBe(
      'Env override NEEM_PROXY_TLS_KEY_PATH: proxy.tls.keyPath (unset) -> /secrets/key.pem',
    )
  })
})
