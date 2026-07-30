import type {
  ServerHost,
  ServerHostOptions,
  ServerRuntimeName,
} from '@nmtjs/server'

import type { HttpAdapterParams, HttpAdapterServer } from './types.ts'

/**
 * Shared-server mode mounts onto the provided host; listen mode owns a
 * private one — either way a ServerHost is the only socket owner, so both
 * modes exercise the same server code path.
 */
export function createHostAdapter<R extends ServerRuntimeName>(
  createHost: (options: ServerHostOptions<R>) => ServerHost<R>,
  params: HttpAdapterParams<R>,
): HttpAdapterServer {
  let host: ServerHost<R>
  if (params.server) {
    host = params.server
  } else if (params.listen) {
    host = createHost({
      listen: params.listen,
      tls: params.tls,
      maxRequestBodySize: params.maxRequestBodySize,
      runtime: params.runtime,
    })
  } else {
    throw new Error('Either `server` or `listen` option is required')
  }
  host.setFetchHandler(params.fetchHandler)
  return {
    get runtime() {
      return host.native
    },
    start: () => host.start(),
    stop: () => host.stop(),
  }
}
