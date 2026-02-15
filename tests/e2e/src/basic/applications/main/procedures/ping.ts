import { n, t } from 'nmtjs'

export const pingProcedure = n.procedure({
  input: t.object({}),
  output: t.object({ message: t.string() }),
  handler: () => {
    return { message: 'pong' }
  },
})
