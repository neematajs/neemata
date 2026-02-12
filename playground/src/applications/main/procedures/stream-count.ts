import { n, t } from 'nmtjs'

export const streamCountProcedure = n.procedure({
  input: t.object({ count: t.number() }),
  output: t.object({ index: t.number() }),
  stream: true,
  async *handler(_, { count }) {
    for (let index = 0; index < count; index++) {
      yield { index }
    }
  },
})
