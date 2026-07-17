import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WS_MAX_BACKPRESSURE,
  DEFAULT_WS_MAX_PAYLOAD,
  resolveUwsWsOptions,
} from '../src/runtimes/node.ts'

describe('resolveUwsWsOptions', () => {
  it('applies both defaults when no runtime options are given', () => {
    expect(resolveUwsWsOptions(undefined)).toEqual({
      maxPayloadLength: DEFAULT_WS_MAX_PAYLOAD,
      maxBackpressure: DEFAULT_WS_MAX_BACKPRESSURE,
    })
  })

  it('applies both defaults when the fields are explicitly undefined', () => {
    // e.g. populated from optional env vars — must not erase the framework
    // defaults and resurrect uWS's socket-killing 16KiB payload cap
    const resolved = resolveUwsWsOptions({
      maxPayloadLength: undefined,
      maxBackpressure: undefined,
    })

    expect(resolved.maxPayloadLength).toBe(DEFAULT_WS_MAX_PAYLOAD)
    expect(resolved.maxBackpressure).toBe(DEFAULT_WS_MAX_BACKPRESSURE)
  })

  it('lets explicit user values win over the defaults', () => {
    const resolved = resolveUwsWsOptions({
      maxPayloadLength: 2048,
      maxBackpressure: 4096,
      idleTimeout: 60,
    })

    expect(resolved.maxPayloadLength).toBe(2048)
    expect(resolved.maxBackpressure).toBe(4096)
    expect(resolved.idleTimeout).toBe(60)
  })
})
