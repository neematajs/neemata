import { c, n, t } from 'nmtjs'

export const streamBlobProcedure = n.procedure({
  input: t.object({ file: c.blob() }),
  output: t.object({ chunk: t.string() }),
  stream: true,
  handler: async function* (_, input) {
    const blob = input.file()

    for await (const chunk of blob) {
      yield {
        chunk: Buffer.from(
          chunk.buffer,
          chunk.byteOffset,
          chunk.byteLength,
        ).toString('utf-8'),
      }
    }
  },
})
