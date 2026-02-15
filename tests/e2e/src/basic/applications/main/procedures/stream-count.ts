import { n, t } from 'nmtjs'

export const streamCountProcedure = n.procedure({
  input: t.object({ count: t.number() }),
  output: t.object({ index: t.number() }),
  stream: true,
  handler: async function* (_, input) {
    for (let index = 0; index < input.count; index++) {
      yield { index }
    }
  },
})
