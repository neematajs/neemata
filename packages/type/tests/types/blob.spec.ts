import { ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it } from 'vitest'

import { blobType, t } from '../../src/index.ts'

describe('BlobType', () => {
  it('composes with other Zod-backed Neemata types', () => {
    const schema = t.object({ file: blobType({ maxSize: 10 }) })
    const file = new ProtocolBlob({ source: 'hello', size: 5 })

    expect(schema.decode({ file })).toEqual({ file })
    expect(schema.encode({ file })).toEqual({ file })
  })

  it('applies size limits only when decoding incoming blobs', () => {
    const schema = blobType({ maxSize: 2 })
    const file = new ProtocolBlob({ source: 'hello', size: 5 })

    expect(() => schema.decode(file)).toThrow(t.NeemataTypeError)
    expect(schema.encode(file)).toBe(file)
  })
})
