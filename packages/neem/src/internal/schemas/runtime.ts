import * as z from 'zod/mini'

import type { NeemRuntimeUpstream } from '../../shared/types.ts'

export const runtimeUpstreamSchema = z.looseObject({
  type: z.enum(['http', 'http2', 'ws']),
  url: z.url(),
})

export const runtimeUpstreamsSchema = z.array(runtimeUpstreamSchema)

export function parseRuntimeUpstreams(
  upstreams: unknown,
): readonly NeemRuntimeUpstream[] {
  return runtimeUpstreamsSchema.parse(
    upstreams,
  ) as readonly NeemRuntimeUpstream[]
}

const runtimeStartResultSchema = z.optional(runtimeUpstreamsSchema)

export function parseRuntimeStartResult(
  result: unknown,
): readonly NeemRuntimeUpstream[] {
  const parsed = runtimeStartResultSchema.parse(result)
  return (parsed ?? []) as readonly NeemRuntimeUpstream[]
}
