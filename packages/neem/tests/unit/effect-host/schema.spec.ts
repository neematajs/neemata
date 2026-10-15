import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  RunnerRpcs,
  ThreadRpcs,
  workerUpdateSchema,
} from '../../../src/internal/protocol.ts'
import { parseManifest } from '../../../src/internal/schemas/manifest.ts'
import { parseRuntimeStartResult } from '../../../src/internal/schemas/runtime.ts'

// The build format is shared, but this decoder is independently Effect-owned.
const artifact = {
  id: 'entry',
  kind: 'module',
  owner: { type: 'config' },
  file: 'runtime/entry.js',
  outDir: 'runtime',
}
const manifest = () => ({
  schemaVersion: 5,
  runtime: {
    entry: 'start.js',
    start: artifact,
    worker: artifact,
    runner: artifact,
  },
  config: { runtimes: {} },
  runtimes: {},
})

describe('Effect boundary schemas', () => {
  it('rejects unexpected manifest fields and unsafe artifact paths', () => {
    expect(() => parseManifest({ ...manifest(), extra: true })).toThrow()
    for (const path of ['../../entry.js', '/entry.js', '']) {
      const value = manifest()
      value.runtime.worker = { ...artifact, file: path }
      expect(() => parseManifest(value)).toThrow('relative path')
    }
    expect(parseManifest({ ...manifest(), plugins: undefined })).toMatchObject({
      schemaVersion: 5,
    })
  })
  it('validates runtime results before routes reach the proxy', () => {
    expect(parseRuntimeStartResult(undefined)).toEqual([])
    expect(() =>
      parseRuntimeStartResult([{ type: 'http', url: 'bad' }]),
    ).toThrow('valid URL')
    expect(() =>
      parseRuntimeStartResult([{ type: 'smtp', url: 'http://localhost' }]),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(workerUpdateSchema)({
        type: 'Patch',
        filename: 'patch.js',
        seq: '1',
        changedIds: [],
      }),
    ).toThrow()
  })
  it('preserves structured-clone application data while checking the planner envelope', () => {
    const schema = RunnerRpcs.requests.get('plan')!.successSchema
    const data = {
      workers: [
        { count: 5n, map: new Map([['a', 1]]), bytes: new Uint8Array([3, 4]) },
      ],
    }
    const encoded = Schema.encodeSync(schema)(data)
    expect(Schema.decodeUnknownSync(schema)(structuredClone(encoded))).toEqual(
      data,
    )
    expect(() => Schema.decodeUnknownSync(schema)({ workers: 42 })).toThrow()
  })
  it('accepts patch requests whose optional fields are present but undefined', () => {
    const schema = ThreadRpcs.requests.get('patch')!.payloadSchema
    for (const update of [
      { type: 'Noop' as const },
      { type: 'FullReload' as const, reason: undefined },
    ]) {
      const payload = { update, url: undefined }
      const encoded = Schema.encodeSync(schema)(payload)
      expect(
        Schema.decodeUnknownSync(schema)(structuredClone(encoded)),
      ).toMatchObject({ update: { type: update.type } })
    }
  })
  it('carries the startup error name, stack, and cause through the RPC codec', () => {
    const schema = ThreadRpcs.requests.get('start')!.errorSchema
    const error = new TypeError('startup failed', {
      cause: new Error('root failure'),
    })
    const decoded = Schema.decodeUnknownSync(schema)(
      structuredClone(Schema.encodeSync(schema)({ origin: 'start', error })),
    )
    expect(decoded).toMatchObject({
      origin: 'start',
      error: {
        name: 'TypeError',
        message: 'startup failed',
        stack: error.stack,
        cause: { message: 'root failure' },
      },
    })
  })
})
