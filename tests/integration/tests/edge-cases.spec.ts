import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TestSetup } from './_setup.ts'
import {
  createProcedure,
  createRootRouter,
  createRouter,
  createTestSetup,
  t,
} from './_setup.ts'

// =============================================================================
// Procedures for Edge Case Tests
// =============================================================================

const fastProcedure = createProcedure({
  input: t.object({}),
  output: t.object({ result: t.string() }),
  handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { result: 'fast' }
  },
})

const streamProcedure = createProcedure({
  input: t.object({ count: t.number() }),
  output: t.object({ index: t.number() }),
  stream: true,
  async *handler(_, { count }) {
    for (let i = 0; i < count; i++) {
      yield { index: i }
    }
  },
})

const router = createRootRouter([
  createRouter({ routes: { fast: fastProcedure, stream: streamProcedure } }),
] as const)

// =============================================================================
// Tests
// =============================================================================

describe('Edge Cases', () => {
  let setup: TestSetup<typeof router>

  beforeEach(async () => {
    setup = await createTestSetup({ router })
  })

  afterEach(async () => {
    await setup.cleanup()
  })

  describe('Race Conditions', () => {
    it('should handle abort racing with response', async () => {
      const controller = new AbortController()
      const callPromise = setup.client.call.fast(
        {},
        { signal: controller.signal },
      )

      // Abort right away - might race with response
      controller.abort()

      // Either rejects (abort won) or resolves (response won)
      await expect(callPromise).rejects.toThrow()
    })

    it('should handle many concurrent streams', async () => {
      const streamPromises = Array.from({ length: 10 }, () =>
        setup.client.stream.stream({ count: 5 }),
      )

      const streams = await Promise.all(streamPromises)

      const results = await Promise.all(
        streams.map(async (stream) => {
          const chunks: unknown[] = []
          for await (const chunk of stream) {
            chunks.push(chunk)
          }
          return chunks
        }),
      )

      // All streams should have received all chunks
      for (const chunks of results) {
        expect(chunks).toHaveLength(5)
      }
    })
  })
})
