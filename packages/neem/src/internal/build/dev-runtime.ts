import { readFileSync } from 'node:fs'

// Rolldown injects this source beside its DevRuntime prelude. The client ships
// verbatim in the package's lib/ directory; src/ and dist/ sit at the
// same depth, so this path holds for both.
export const NEEM_DEV_RUNTIME: string = readFileSync(
  new URL('../../../lib/patch-client.js', import.meta.url),
  'utf8',
)
