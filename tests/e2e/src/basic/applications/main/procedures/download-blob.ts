import { c, n, t } from 'nmtjs'

export const downloadBlobProcedure = n.procedure({
  dependencies: { createBlob: n.inject.createBlob },
  input: t.object({ content: t.string(), filename: t.string().optional() }),
  output: c.blob(),
  handler: ({ createBlob }, input) => {
    const buffer = Buffer.from(input.content, 'utf-8')

    return createBlob(buffer, {
      type: 'text/plain',
      size: buffer.byteLength,
      filename: input.filename,
    })
  },
})
