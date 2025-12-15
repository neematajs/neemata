import { n } from 'nmtjs'

import { pingProcedure } from './procedures/ping.ts'

export const router = n.rootRouter([
  n.router({ routes: { ping: pingProcedure } }),
])
