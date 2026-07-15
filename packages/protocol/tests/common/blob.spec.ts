import { describe, expect, it } from 'vitest'

import { ProtocolBlob } from '../../src/common/blob.ts'

const readAll = async (source: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return Buffer.concat(chunks)
}

describe('ProtocolBlob', () => {
  describe('content type inference', () => {
    it('should infer type from a Blob source', () => {
      const blob = ProtocolBlob.from(
        new Blob(['<svg/>'], { type: 'image/svg+xml' }),
      )
      expect(blob.metadata.type).toBe('image/svg+xml')
    })

    it('should infer type from a File source', () => {
      const blob = ProtocolBlob.from(
        new File(['{}'], 'data.json', { type: 'application/json' }),
      )
      expect(blob.metadata.type).toBe('application/json')
      expect(blob.metadata.filename).toBe('data.json')
    })

    it('should infer text/plain for a string source', () => {
      const blob = ProtocolBlob.from('hello')
      expect(blob.metadata.type).toBe('text/plain')
    })

    it('should prefer explicit metadata type over inference', () => {
      const blob = ProtocolBlob.from(
        new Blob(['<svg/>'], { type: 'image/svg+xml' }),
        { type: 'text/html' },
      )
      expect(blob.metadata.type).toBe('text/html')

      const text = ProtocolBlob.from('hello', { type: 'text/csv' })
      expect(text.metadata.type).toBe('text/csv')
    })

    it('should default to application/octet-stream when nothing is inferred', () => {
      const binary = ProtocolBlob.from(new Uint8Array([1, 2, 3]))
      expect(binary.metadata.type).toBe('application/octet-stream')

      // Blob with no type reports an empty string — not a real content type
      const untyped = ProtocolBlob.from(new Blob(['data']))
      expect(untyped.metadata.type).toBe('application/octet-stream')
    })
  })

  describe('zero-byte blobs', () => {
    it('should allow zero-byte sources', () => {
      expect(ProtocolBlob.from(new Blob([])).metadata.size).toBe(0)
      expect(ProtocolBlob.from('').metadata.size).toBe(0)
      expect(ProtocolBlob.from(new Uint8Array(0)).metadata.size).toBe(0)
      expect(ProtocolBlob.from(new ArrayBuffer(0)).metadata.size).toBe(0)
      expect(new ProtocolBlob({ source: null, size: 0 }).metadata.size).toBe(0)
    })

    it('should round-trip zero bytes through the source stream', async () => {
      const blob = ProtocolBlob.from(new Blob([]))
      const bytes = await readAll(blob.source)
      expect(bytes.byteLength).toBe(0)
    })

    it('should still reject negative and NaN sizes', () => {
      expect(() => new ProtocolBlob({ source: null, size: -1 })).toThrow(
        'Blob size is invalid',
      )
      expect(
        () => new ProtocolBlob({ source: null, size: Number.NaN }),
      ).toThrow('Blob size is invalid')
    })
  })
})
