import * as Schema from 'effect/Schema'

import type { NeemRuntimeUpstream } from '../../shared/types.ts'

export const runtimeUpstreamSchema = Schema.Struct({
  type: Schema.Literals(['http', 'http2', 'ws']),
  url: Schema.String.check(
    Schema.makeFilter((url) => URL.canParse(url) || 'Expected a valid URL'),
  ),
})
export const runtimeUpstreamsSchema = Schema.Array(runtimeUpstreamSchema)
export const parseRuntimeUpstreams = (
  upstreams: unknown,
): readonly NeemRuntimeUpstream[] =>
  Schema.decodeUnknownSync(runtimeUpstreamsSchema)(upstreams)
export const parseRuntimeStartResult = (
  result: unknown,
): readonly NeemRuntimeUpstream[] =>
  result === undefined ? [] : parseRuntimeUpstreams(result)
