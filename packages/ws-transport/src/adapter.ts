import type {
  ServerHost,
  ServerHostOptions,
  ServerRuntimeName,
} from '@nmtjs/server'

import type { WsAdapterParams, WsAdapterServer } from './types.ts'

/**
 * Shared-server mode mounts onto the provided host; listen mode owns a
 * private one — either way a ServerHost is the only socket owner, so both
 * modes exercise the same server code path.
 */
export function createHostAdapter<R extends ServerRuntimeName>(
  createHost: (options: ServerHostOptions<R>) => ServerHost<R>,
  params: WsAdapterParams<R>,
): WsAdapterServer {
  let host: ServerHost<R>
  if (params.server) {
    host = params.server
  } else if (params.listen) {
    host = createHost({
      listen: params.listen,
      tls: params.tls,
      runtime: params.runtime,
    })
  } else {
    throw new Error('Either `server` or `listen` option is required')
  }
  host.setWebSocket({ hooks: params.wsHooks, options: params.ws })
  return {
    start: () => host.start(),
    stop: () => host.stop(),
    isSendSuccess: (status) => host.isSendSuccess(status),
  }
}
