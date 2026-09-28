import { describe, expect, it } from 'vitest'

import type { ManifestConfig } from '../../src/internal/manifest/manifest.ts'
import {
  applyHostConfigEnvOverrides,
  formatAppliedEnvOverride,
} from '../../src/internal/manifest/env-overrides.ts'

const baseConfig: ManifestConfig = {
  server: { hostname: '127.0.0.1', port: 8000 },
  runtimes: {},
}

describe('Neem host config env overrides', () => {
  it('returns the config untouched when no override vars are set', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {})

    expect(result.config).toBe(baseConfig)
    expect(result.applied).toEqual([])
  })

  it('overrides server port and hostname from NEEM_SERVER_* vars', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_SERVER_PORT: '3000',
      NEEM_SERVER_HOSTNAME: '0.0.0.0',
    })

    expect(result.config.server).toEqual({ hostname: '0.0.0.0', port: 3000 })
    expect(result.applied).toEqual([
      {
        source: 'NEEM_SERVER_PORT',
        path: 'server.port',
        from: 8000,
        to: 3000,
      },
      {
        source: 'NEEM_SERVER_HOSTNAME',
        path: 'server.hostname',
        from: '127.0.0.1',
        to: '0.0.0.0',
      },
    ])
  })

  it('falls back to the platform PORT convention for the server port', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, { PORT: '5000' })

    expect(result.config.server?.port).toBe(5000)
    expect(result.applied).toEqual([
      { source: 'PORT', path: 'server.port', from: 8000, to: 5000 },
    ])
  })

  it('prefers NEEM_SERVER_PORT over PORT', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_SERVER_PORT: '3000',
      PORT: '5000',
    })

    expect(result.config.server?.port).toBe(3000)
  })

  // The server always runs, so a deploy can set it up without any config.
  it('applies overrides when neem.config.ts configures no server', () => {
    const config: ManifestConfig = { runtimes: {} }
    const result = applyHostConfigEnvOverrides(config, {
      PORT: '5000',
      NEEM_SERVER_HOSTNAME: '::',
    })

    expect(result.config.server).toEqual({ hostname: '::', port: 5000 })
    expect(config.server).toBeUndefined()
  })

  it('does not mutate the input config', () => {
    applyHostConfigEnvOverrides(baseConfig, { NEEM_SERVER_PORT: '3000' })

    expect(baseConfig.server?.port).toBe(8000)
  })

  it('enables server TLS when both path vars are set', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_SERVER_TLS_KEY_PATH: '/secrets/key.pem',
      NEEM_SERVER_TLS_CERT_PATH: '/secrets/cert.pem',
    })

    expect(result.config.server?.tls).toEqual({
      keyPath: '/secrets/key.pem',
      certPath: '/secrets/cert.pem',
    })
  })

  it('overrides a single TLS path when TLS is already configured', () => {
    const config: ManifestConfig = {
      ...baseConfig,
      server: {
        hostname: '127.0.0.1',
        port: 8000,
        tls: { keyPath: '/old/key.pem', certPath: '/old/cert.pem' },
      },
    }
    const result = applyHostConfigEnvOverrides(config, {
      NEEM_SERVER_TLS_KEY_PATH: '/new/key.pem',
    })

    expect(result.config.server?.tls).toEqual({
      keyPath: '/new/key.pem',
      certPath: '/old/cert.pem',
    })
  })

  it('rejects enabling TLS with only one of the path vars', () => {
    expect(() =>
      applyHostConfigEnvOverrides(baseConfig, {
        NEEM_SERVER_TLS_KEY_PATH: '/secrets/key.pem',
      }),
    ).toThrow(/Both NEEM_SERVER_TLS_KEY_PATH and NEEM_SERVER_TLS_CERT_PATH/)
  })

  it('rejects non-numeric ports', () => {
    expect(() =>
      applyHostConfigEnvOverrides(baseConfig, { NEEM_SERVER_PORT: 'nope' }),
    ).toThrow(/Invalid NEEM_SERVER_PORT="nope"/)
    expect(() =>
      applyHostConfigEnvOverrides(baseConfig, { PORT: '70000' }),
    ).toThrow(/Invalid PORT="70000"/)
  })

  it('treats empty values as unset', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_SERVER_PORT: '',
      PORT: '5000',
      NEEM_SERVER_HOSTNAME: '',
    })

    expect(result.config.server).toEqual({ hostname: '127.0.0.1', port: 5000 })
  })

  it('skips no-op overrides matching the manifest value', () => {
    const result = applyHostConfigEnvOverrides(baseConfig, {
      NEEM_SERVER_PORT: '8000',
    })

    expect(result.config).toBe(baseConfig)
    expect(result.applied).toEqual([])
  })

  it('formats applied overrides for logging', () => {
    expect(
      formatAppliedEnvOverride({
        source: 'NEEM_SERVER_PORT',
        path: 'server.port',
        from: 8000,
        to: 3000,
      }),
    ).toBe('Env override NEEM_SERVER_PORT: server.port 8000 -> 3000')
    expect(
      formatAppliedEnvOverride({
        source: 'NEEM_SERVER_TLS_KEY_PATH',
        path: 'server.tls.keyPath',
        from: undefined,
        to: '/secrets/key.pem',
      }),
    ).toBe(
      'Env override NEEM_SERVER_TLS_KEY_PATH: server.tls.keyPath (unset) -> /secrets/key.pem',
    )
  })
})
