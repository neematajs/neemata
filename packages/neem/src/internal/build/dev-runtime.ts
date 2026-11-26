import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const COMMON_RUNTIME_MARKER = '/runtime-extra-dev-common.js\n'
const COMMON_RUNTIME_EXPORT = '\nexport { DevRuntime'

// Since Rolldown 1.3.3 (rolldown#11776) a custom `devMode.implement` must
// carry the DevRuntime class itself. The package ships that class only inside
// the `rolldown/experimental/runtime` module, after its own copy of the runtime
// helpers. The runtime chunk already declares those helpers, so keep only the
// common dev runtime region and drop the module's export. Throw rather than
// guess when the bundle layout changes.
function readCommonDevRuntime(): string {
  const source = readFileSync(
    fileURLToPath(import.meta.resolve('rolldown/experimental/runtime')),
    'utf8',
  )
  const start = source.indexOf(COMMON_RUNTIME_MARKER)
  const end = source.lastIndexOf(COMMON_RUNTIME_EXPORT)
  if (start === -1 || end < start) {
    throw new Error(
      'Unsupported rolldown/experimental/runtime layout: cannot find the DevRuntime source',
    )
  }
  return source.slice(start + COMMON_RUNTIME_MARKER.length, end + 1)
}

// The client ships verbatim in the package's lib/ directory; src/ and dist/
// sit at the same depth, so this path holds for both.
export const NEEM_PATCH_CLIENT: string = readFileSync(
  new URL('../../../lib/patch-client.js', import.meta.url),
  'utf8',
)

let devRuntime: string | undefined

// Rolldown injects this source into its runtime chunk. Built on first use so
// that only dev mode depends on the runtime bundle layout, not build/preview.
export function getNeemDevRuntime(): string {
  devRuntime ??= readCommonDevRuntime() + NEEM_PATCH_CLIENT
  return devRuntime
}
