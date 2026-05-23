import { setTimeout } from 'node:timers/promises'

import { n, t } from 'nmtjs'

export const slowAbortProcedure = n.procedure({
  input: t.object({}),
  output: t.object({ ok: t.boolean() }),
  handler: async () => {
    await setTimeout(300)
    return { ok: true }
  },
})
