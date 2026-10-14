import {
  HostController,
  createHostHooks,
  type RuntimeSnapshot,
} from '@nmtjs/neem/host'

// The published declarations must expose the embedding API without source files
// or access to the workspace's former internal package exports.
export function createHost(snapshot: RuntimeSnapshot): HostController {
  return new HostController({ snapshot, hooks: createHostHooks() })
}
