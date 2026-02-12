import { n } from 'nmtjs'

import { pingProcedure } from './procedures/ping.ts'
import { streamCountProcedure } from './procedures/stream-count.ts'

export const router = n.rootRouter([
  n.router({
    routes: { ping: pingProcedure, streamCount: streamCountProcedure },
  }),
])
