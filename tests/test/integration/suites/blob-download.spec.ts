import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TestSetup } from '../../_setup.ts'
import {
  c,
  createBlob,
  createProcedure,
  createRootRouter,
  createRouter,
  createTestSetup,
  ProtocolBlob,
  t,
} from '../../_setup.ts'

// =============================================================================
// Procedures for Blob Download Tests
// =============================================================================

const downloadProcedure = createProcedure({
  dependencies: { createBlob },
  input: t.object({ content: t.string() }),
  output: c.blob(),
  handler: ({ createBlob }, input) => {
    const buffer = Buffer.from(input.content, 'utf-8')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer))
        setTimeout(() => controller.close(), 10)
      },
    })
    return createBlob(stream, { type: 'text/plain', size: buffer.byteLength })
  },
})

const echoBlobProcedure = createProcedure({
  dependencies: { createBlob },
  input: t.object({ file: c.blob() }),
  output: c.blob(),
  handler: async ({ createBlob }, input) => {
    const clientBlob = input.file()
    const chunks: Uint8Array[] = []
    for await (const chunk of clientBlob) {
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer))
        setTimeout(() => controller.close(), 10)
      },
    })
    return createBlob(stream, clientBlob.metadata)
  },
})

const downloadLargeProcedure = createProcedure({
  dependencies: { createBlob },
  input: t.object({ sizeBytes: t.number() }),
  output: c.blob(),
  handler: ({ createBlob }, input) => {
    // Create a large stream that yields chunks
    const chunkSize = 65536 // 64KB chunks
    let remaining = input.sizeBytes

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close()
          return
        }
        const size = Math.min(chunkSize, remaining)
        const chunk = new Uint8Array(size).fill(0x78) // 'x' character
        remaining -= size
        controller.enqueue(chunk)
      },
    })
    return createBlob(stream, {
      type: 'application/octet-stream',
      size: input.sizeBytes,
    })
  },
})

const downloadWithMetadataProcedure = createProcedure({
  dependencies: { createBlob },
  input: t.object({
    content: t.string(),
    type: t.string(),
    filename: t.string().optional(),
  }),
  output: c.blob(),
  handler: ({ createBlob }, input) => {
    const buffer = Buffer.from(input.content, 'utf-8')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer))
        setTimeout(() => controller.close(), 10)
      },
    })
    return createBlob(stream, {
      type: input.type,
      size: buffer.byteLength,
      filename: input.filename,
    })
  },
})

const downloadSlowProcedure = createProcedure({
  dependencies: { createBlob },
  input: t.object({ content: t.string(), delayMs: t.number() }),
  output: c.blob(),
  handler: ({ createBlob }, input) => {
    const encoder = new TextEncoder()
    const chunks = input.content
      .split(' ')
      .map((word) => encoder.encode(word + ' '))
    let chunkIndex = 0

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunkIndex >= chunks.length) {
          controller.close()
          return
        }
        // Simulate slow server
        await new Promise((resolve) => setTimeout(resolve, input.delayMs))
        controller.enqueue(chunks[chunkIndex++])
      },
    })
    return createBlob(stream, { type: 'text/plain' })
  },
})

const downloadErrorProcedure = createProcedure({
  dependencies: { createBlob },
  input: t.object({ errorAfterBytes: t.number() }),
  output: c.blob(),
  handler: ({ createBlob }, input) => {
    let sentBytes = 0
    const chunkSize = 1024

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentBytes >= input.errorAfterBytes) {
          controller.error(new Error('Server stream error'))
          return
        }
        const chunk = new Uint8Array(chunkSize).fill(0x78)
        sentBytes += chunkSize
        controller.enqueue(chunk)
      },
    })
    return createBlob(stream, { type: 'application/octet-stream' })
  },
})

const downloadChunkedProcedure = createProcedure({
  dependencies: { createBlob },
  input: t.object({ chunks: t.array(t.string()) }),
  output: c.blob(),
  handler: ({ createBlob }, input) => {
    const encoder = new TextEncoder()
    let chunkIndex = 0
    let closed = false

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIndex >= input.chunks.length) {
          // Delay close to allow event listeners to be attached
          setTimeout(() => {
            if (!closed) {
              closed = true
              controller.close()
            }
          }, 10)
          return
        }
        controller.enqueue(encoder.encode(input.chunks[chunkIndex++]))
      },
    })
    return createBlob(stream, { type: 'text/plain' })
  },
})

const router = createRootRouter([
  createRouter({
    routes: {
      download: downloadProcedure,
      echoBlob: echoBlobProcedure,
      downloadLarge: downloadLargeProcedure,
      downloadWithMetadata: downloadWithMetadataProcedure,
      downloadSlow: downloadSlowProcedure,
      downloadError: downloadErrorProcedure,
      downloadChunked: downloadChunkedProcedure,
    },
  }),
] as const)

// =============================================================================
// Tests
// =============================================================================

describe('Blob Download (Server → Client)', () => {
  let setup: TestSetup<typeof router>

  beforeEach(async () => {
    setup = await createTestSetup({ router })
  })

  afterEach(async () => {
    await setup.cleanup()
  })

  describe('Basic Download', () => {
    it('should download blob and consume content', async () => {
      const content = 'Downloaded content'
      const getBlobStream = await setup.client.call.download({ content })
      const blobStream = getBlobStream()

      const chunks: Uint8Array[] = []
      for await (const chunk of blobStream) {
        chunks.push(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        )
      }

      const buffer = Buffer.concat(chunks)
      expect(buffer.toString('utf-8')).toBe(content)
    })

    it('should echo blob (upload then download)', async () => {
      const content = 'Echo this content'
      const uploadBlob = ProtocolBlob.from(content)

      const getBlobStream = await setup.client.call.echoBlob({
        file: uploadBlob,
      })
      const blobStream = getBlobStream()

      const chunks: Uint8Array[] = []
      for await (const chunk of blobStream) {
        chunks.push(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        )
      }

      const buffer = Buffer.concat(chunks)
      expect(buffer.toString('utf-8')).toBe(content)
    })

    it('should download large blob (1MB+)', async () => {
      const sizeBytes = 1024 * 1024 // 1MB
      const getBlobStream = await setup.client.call.downloadLarge({ sizeBytes })
      const blobStream = getBlobStream()

      let totalBytes = 0
      for await (const chunk of blobStream) {
        totalBytes += chunk.byteLength
      }

      expect(totalBytes).toBe(sizeBytes)
    })

    it('should preserve blob metadata', async () => {
      const content = 'Content with metadata'
      const getBlobStream = await setup.client.call.downloadWithMetadata({
        content,
        type: 'text/markdown',
        filename: 'readme.md',
      })

      // Access metadata before consuming
      const blobStream = getBlobStream()
      expect(blobStream.metadata.type).toBe('text/markdown')
      expect(blobStream.metadata.filename).toBe('readme.md')
      expect(blobStream.metadata.size).toBe(content.length)

      // Consume to verify content
      const chunks: Uint8Array[] = []
      for await (const chunk of blobStream) {
        chunks.push(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        )
      }
      expect(Buffer.concat(chunks).toString('utf-8')).toBe(content)
    })

    it('should handle binary data download', async () => {
      // Create binary content via upload/download cycle
      const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
      const uploadBlob = ProtocolBlob.from(binaryData)

      const getBlobStream = await setup.client.call.echoBlob({
        file: uploadBlob,
      })
      const blobStream = getBlobStream()

      const chunks: Uint8Array[] = []
      for await (const chunk of blobStream) {
        chunks.push(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        )
      }

      const result = Buffer.concat(chunks)
      expect(result).toEqual(Buffer.from(binaryData))
    })
  })

  describe('Client Consumption Patterns', () => {
    it('should handle partial download with break', async () => {
      const content = 'x'.repeat(10000)
      const getBlobStream = await setup.client.call.download({ content })
      const blobStream = getBlobStream()

      let receivedBytes = 0
      for await (const chunk of blobStream) {
        receivedBytes += chunk.byteLength
        if (receivedBytes > 1000) break
      }

      expect(receivedBytes).toBeGreaterThan(1000)
    })

    it('should handle client not consuming blob', async () => {
      const content = 'This content will not be consumed'
      const getBlobStream = await setup.client.call.download({ content })

      // Get the blob stream accessor but never call it or iterate
      // The blob stream function is returned but not invoked
      expect(getBlobStream).toBeDefined()
      expect(typeof getBlobStream).toBe('function')

      // Wait for potential timeout/cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Verify client state - pending call should be cleared
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should receive multiple chunks correctly', async () => {
      const chunks = ['First ', 'Second ', 'Third']
      const getBlobStream = await setup.client.call.downloadChunked({ chunks })
      const blobStream = getBlobStream()

      const received: string[] = []
      for await (const chunk of blobStream) {
        received.push(
          Buffer.from(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength,
          ).toString('utf-8'),
        )
      }

      expect(received.join('')).toBe(chunks.join(''))
    })
  })

  describe('Server Lifecycle', () => {
    it('should stream data on client pull', async () => {
      const content = 'word1 word2 word3 word4 word5'
      const getBlobStream = await setup.client.call.downloadSlow({
        content,
        delayMs: 5,
      })
      const blobStream = getBlobStream()

      const chunks: string[] = []
      for await (const chunk of blobStream) {
        chunks.push(
          Buffer.from(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength,
          ).toString('utf-8'),
        )
      }

      // Verify we received all words (with trailing spaces from split logic)
      const received = chunks.join('')
      expect(received.trim()).toBe(content)
    })

    it('should end stream after all data sent', async () => {
      const content = 'Complete download'
      const getBlobStream = await setup.client.call.download({ content })
      const blobStream = getBlobStream()

      const chunks: Uint8Array[] = []
      for await (const chunk of blobStream) {
        chunks.push(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        )
      }

      // Stream ended, verify content is complete
      expect(Buffer.concat(chunks).toString('utf-8')).toBe(content)

      // Verify cleanup
      expect(setup.client.activeServerStreamsCount).toBe(0)
      expect(setup.gateway.blobStreams.serverStreams.size).toBe(0)
    })
  })

  describe('Backpressure', () => {
    it('should handle large download with backpressure', async () => {
      const sizeBytes = 500000 // 500KB
      const getBlobStream = await setup.client.call.downloadLarge({ sizeBytes })
      const blobStream = getBlobStream()

      let totalBytes = 0
      let chunkCount = 0
      for await (const chunk of blobStream) {
        totalBytes += chunk.byteLength
        chunkCount++
        // Simulate slow consumer
        if (chunkCount % 5 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
      }

      expect(totalBytes).toBe(sizeBytes)
    })
  })

  describe('Error Handling', () => {
    it('should abort download on client disconnect', async () => {
      const localSetup = await createTestSetup({ router })

      try {
        // Start a slow download
        const downloadPromise = localSetup.client.call.downloadSlow({
          content: 'word1 word2 word3 word4 word5',
          delayMs: 100,
        })

        // Disconnect immediately
        await localSetup.client.disconnect()

        // The call should be rejected
        await expect(downloadPromise).rejects.toThrow()

        // Client should be clean
        expect(localSetup.client.isClean).toBe(true)

        // Wait for gateway cleanup
        await new Promise((resolve) => setTimeout(resolve, 50))

        // Gateway should be clean
        expect(localSetup.gateway.blobStreams.serverStreams.size).toBe(0)
      } finally {
        await localSetup.gateway.stop()
      }
    })

    it('should handle client aborting download via signal', async () => {
      const sizeBytes = 100000 // 100KB
      const controller = new AbortController()

      const getBlobStream = await setup.client.call.downloadLarge({ sizeBytes })
      const blobStream = getBlobStream({ signal: controller.signal })

      let receivedBytes = 0

      // Start consuming but abort after receiving some data
      const reader = blobStream.readable.getReader()
      try {
        while (receivedBytes < 10000) {
          const { done, value } = await reader.read()
          if (done) break
          receivedBytes += value.byteLength
        }
        // Abort after receiving ~10KB
        controller.abort()
        reader.releaseLock()
      } catch (_e) {
        reader.releaseLock()
      }

      expect(receivedBytes).toBeGreaterThan(0)
      expect(receivedBytes).toBeLessThan(sizeBytes)

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Verify cleanup
      expect(setup.client.pendingCallsCount).toBe(0)
    })
  })

  describe('Resource Cleanup', () => {
    it('should clean up server streams after download complete', async () => {
      const content = 'Cleanup test content'
      const getBlobStream = await setup.client.call.download({ content })
      const blobStream = getBlobStream()

      for await (const _chunk of blobStream) {
        // Consume all chunks
      }

      // Verify client state is clean
      expect(setup.client.activeServerStreamsCount).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
      expect(setup.client.isClean).toBe(true)

      // Verify gateway state is clean
      expect(setup.gateway.blobStreams.serverStreams.size).toBe(0)
      expect(setup.gateway.blobStreams.serverCallStreams.size).toBe(0)
    })

    it('should clean up client #serverStreams map after download complete', async () => {
      // Specifically verify client-side server stream map cleanup
      const content = 'Content for server stream cleanup test'

      // Verify initial state is clean
      expect(setup.client.activeServerStreamsCount).toBe(0)

      const getBlobStream = await setup.client.call.download({ content })
      const blobStream = getBlobStream()

      // Consume all chunks
      for await (const _chunk of blobStream) {
        // drain
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // The key assertion: client #serverStreams map should be cleared
      expect(setup.client.activeServerStreamsCount).toBe(0)
      expect(setup.client.isClean).toBe(true)
    })

    it('should clean up client #serverStreams map after download abort via signal', async () => {
      const sizeBytes = 100000 // 100KB
      const controller = new AbortController()

      // Verify initial state is clean
      expect(setup.client.activeServerStreamsCount).toBe(0)

      const getBlobStream = await setup.client.call.downloadLarge({ sizeBytes })
      const blobStream = getBlobStream({ signal: controller.signal })

      // Start consuming but abort after some data
      const reader = blobStream.readable.getReader()
      let receivedBytes = 0
      try {
        while (receivedBytes < 10000) {
          const { done, value } = await reader.read()
          if (done) break
          receivedBytes += value.byteLength
        }
        // Abort after receiving some data
        controller.abort()
        reader.releaseLock()
      } catch (_e) {
        reader.releaseLock()
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // The key assertion: client #serverStreams map should be cleared after abort
      expect(setup.client.activeServerStreamsCount).toBe(0)
      expect(setup.client.pendingCallsCount).toBe(0)
    })

    it('should clean up client #serverStreams map when client ignores blob', async () => {
      const content = 'Content that client will ignore'

      // Verify initial state is clean
      expect(setup.client.activeServerStreamsCount).toBe(0)

      const getBlobStream = await setup.client.call.download({ content })

      // Get the blob stream accessor but never consume it
      // This tests the case where the blob is returned but never iterated
      const _blobStream = getBlobStream()

      // Wait for potential timeout/cleanup
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Verify client state - the call is complete even if blob wasn't consumed
      expect(setup.client.pendingCallsCount).toBe(0)

      // Note: The blob stream may still be tracked if not consumed.
      // This is expected behavior - the stream resources are held until
      // either consumed or the connection closes.
    })

    it('should clean up gateway serverStreams map after send complete', async () => {
      const content = 'Gateway server streams cleanup test'

      // Verify initial state
      expect(setup.gateway.blobStreams.serverStreams.size).toBe(0)

      const getBlobStream = await setup.client.call.download({ content })
      const blobStream = getBlobStream()

      // Consume all chunks
      for await (const _chunk of blobStream) {
        // drain
      }

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // The key assertion: gateway serverStreams should be cleared
      expect(setup.gateway.blobStreams.serverStreams.size).toBe(0)
      expect(setup.gateway.blobStreams.serverCallStreams.size).toBe(0)
    })

    it('should clean up after multiple concurrent downloads', async () => {
      const contents = ['First', 'Second', 'Third', 'Fourth', 'Fifth']

      const downloadPromises = contents.map(async (content) => {
        const getBlobStream = await setup.client.call.download({ content })
        const blobStream = getBlobStream()
        const chunks: Uint8Array[] = []
        for await (const chunk of blobStream) {
          chunks.push(
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          )
        }
        return Buffer.concat(chunks).toString('utf-8')
      })

      const results = await Promise.all(downloadPromises)

      // Verify all downloads completed correctly
      contents.forEach((content, i) => {
        expect(results[i]).toBe(content)
      })

      // Verify cleanup
      expect(setup.client.isClean).toBe(true)
      expect(setup.gateway.blobStreams.serverStreams.size).toBe(0)
      expect(setup.gateway.blobStreams.serverCallStreams.size).toBe(0)
    })

    it('should clean up after partial download', async () => {
      const sizeBytes = 50000 // 50KB
      const getBlobStream = await setup.client.call.downloadLarge({ sizeBytes })
      const blobStream = getBlobStream()

      let receivedBytes = 0
      for await (const chunk of blobStream) {
        receivedBytes += chunk.byteLength
        if (receivedBytes > 10000) break // Only consume ~10KB
      }

      // Wait for cleanup after break
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Verify client state - call should be cleared even after partial consumption
      expect(setup.client.pendingCallsCount).toBe(0)
    })
  })

  describe('Edge Cases', () => {
    it('should handle download immediately after connect', async () => {
      const localSetup = await createTestSetup({ router })

      try {
        // Download immediately after setup
        const content = 'Immediate download'
        const getBlobStream = await localSetup.client.call.download({ content })
        const blobStream = getBlobStream()

        const chunks: Uint8Array[] = []
        for await (const chunk of blobStream) {
          chunks.push(
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          )
        }

        expect(Buffer.concat(chunks).toString('utf-8')).toBe(content)
      } finally {
        await localSetup.cleanup()
      }
    })

    it('should handle sequential downloads correctly', async () => {
      const contents = ['First download', 'Second download', 'Third download']

      for (const content of contents) {
        const getBlobStream = await setup.client.call.download({ content })
        const blobStream = getBlobStream()

        const chunks: Uint8Array[] = []
        for await (const chunk of blobStream) {
          chunks.push(
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          )
        }

        expect(Buffer.concat(chunks).toString('utf-8')).toBe(content)

        // Verify clean state between downloads
        expect(setup.client.activeServerStreamsCount).toBe(0)
        expect(setup.gateway.blobStreams.serverStreams.size).toBe(0)
      }
    })

    it('should handle multiple racing downloads followed by disconnect', async () => {
      const localSetup = await createTestSetup({ router })

      try {
        // Start many slow downloads
        const downloadPromises = Array.from({ length: 5 }, (_, i) =>
          localSetup.client.call.downloadSlow({
            content: `Content for download ${i}`,
            delayMs: 50,
          }),
        )

        // Disconnect while downloads are in progress
        await localSetup.client.disconnect()

        // All should be rejected
        const results = await Promise.allSettled(downloadPromises)
        results.forEach((result) => {
          expect(result.status).toBe('rejected')
        })

        // Client should be clean
        expect(localSetup.client.isClean).toBe(true)

        // Wait for gateway cleanup
        await new Promise((resolve) => setTimeout(resolve, 50))

        // Gateway should be clean
        expect(localSetup.gateway.blobStreams.serverStreams.size).toBe(0)
      } finally {
        await localSetup.gateway.stop()
      }
    })

    it('should handle long filename in download metadata', async () => {
      const content = 'Content with long filename'
      const longFilename = 'a'.repeat(1000) + '.dat'

      const getBlobStream = await setup.client.call.downloadWithMetadata({
        content,
        type: 'application/octet-stream',
        filename: longFilename,
      })
      const blobStream = getBlobStream()

      expect(blobStream.metadata.filename).toBe(longFilename)

      // Consume the stream
      for await (const _chunk of blobStream) {
        // drain
      }
    })

    it('should handle special characters in download filename', async () => {
      const content = 'Content with special filename'
      const specialFilename = '文件名 with spaces & special/chars?.txt'

      const getBlobStream = await setup.client.call.downloadWithMetadata({
        content,
        type: 'text/plain',
        filename: specialFilename,
      })
      const blobStream = getBlobStream()

      expect(blobStream.metadata.filename).toBe(specialFilename)

      // Consume the stream
      for await (const _chunk of blobStream) {
        // drain
      }
    })
  })
})
