import * as z from 'zod/mini'

import type { NeemRuntimeUpstream } from '../../shared/types.ts'

const upstreamSchema = z.looseObject({
  type: z.enum(['http', 'http2', 'ws']),
  url: z.url(),
})

const startResultSchema = z.optional(z.array(upstreamSchema))

export function parseRuntimeStartResult(
  result: unknown,
): readonly NeemRuntimeUpstream[] {
  return startResultSchema.parse(result) ?? []
}
