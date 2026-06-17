import { describe, expect, it } from 'vitest'

import {
  parseRuntimeStartResult,
  parseRuntimeUpstreams,
} from '../../src/internal/schemas/runtime.ts'

describe('Neem internal schemas', () => {
  it('parses runtime upstreams returned by workers', () => {
    expect(
      parseRuntimeUpstreams([
        { type: 'http', url: 'http://127.0.0.1:3000' },
        { type: 'ws', url: 'ws://127.0.0.1:3001' },
      ]),
    ).toEqual([
      { type: 'http', url: 'http://127.0.0.1:3000' },
      { type: 'ws', url: 'ws://127.0.0.1:3001' },
    ])
  })

  it('rejects runtime upstreams with unsupported transport types', () => {
    expect(() =>
      parseRuntimeUpstreams([{ type: 'tcp', url: 'http://127.0.0.1:3000' }]),
    ).toThrow(/type/)
  })

  it('rejects runtime upstreams with invalid URLs', () => {
    expect(() =>
      parseRuntimeUpstreams([{ type: 'http', url: 'not-a-valid-url' }]),
    ).toThrow(/url/)
  })

  it('normalizes runtime start results to upstream arrays', () => {
    expect(parseRuntimeStartResult(undefined)).toEqual([])
    expect(
      parseRuntimeStartResult([{ type: 'http', url: 'http://127.0.0.1:3000' }]),
    ).toEqual([{ type: 'http', url: 'http://127.0.0.1:3000' }])
    expect(
      parseRuntimeStartResult({
        upstreams: [{ type: 'ws', url: 'ws://127.0.0.1:3001' }],
      }),
    ).toEqual([{ type: 'ws', url: 'ws://127.0.0.1:3001' }])
    expect(parseRuntimeStartResult({})).toEqual([])
  })
})
