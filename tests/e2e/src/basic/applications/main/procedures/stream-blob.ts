import { c, n, t } from 'nmtjs'

export const streamBlobProcedure = n.procedure({
  dependencies: { consumeBlob: n.inject.consumeBlob },
  input: t.object({ file: c.blob() }),
  output: t.object({ chunk: t.string() }),
  stream: true,
  handler: async function* ({ consumeBlob }, input) {
    const blob = consumeBlob(input.file)

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
