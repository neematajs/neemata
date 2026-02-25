import { c, n, t } from 'nmtjs'

export const uploadBlobProcedure = n.procedure({
  input: t.object({ file: c.blob() }),
  output: t.object({
    size: t.number(),
    content: t.string(),
    type: t.string(),
    filename: t.string().optional(),
  }),
  handler: async (_, input) => {
    const blob = input.file()
    const chunks: Buffer[] = []

    for await (const chunk of blob) {
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    }

    const buffer = Buffer.concat(chunks)
    return {
      size: buffer.byteLength,
      content: buffer.toString('utf-8'),
      type: blob.metadata.type,
      filename: blob.metadata.filename,
    }
  },
})
