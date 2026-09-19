import type { RpcCommand } from '../rpc.ts'
import type { WorkerServiceStopProgressEvent } from '../services/client.ts'
import type { NeemTestProbe } from '../test-probe.ts'
import { resolveServiceEntry, WorkerServiceClient } from '../services/client.ts'

export type ServiceClientOptions<TEvent> = {
  probe?: NeemTestProbe
  onEvent: (event: TEvent) => void
  onFailure: (error: Error) => void
}

export function createServiceClient<
  TCommand extends RpcCommand,
  TEvent,
  TResult,
>(
  name: 'watcher' | 'runtime',
  options: ServiceClientOptions<TEvent>,
): WorkerServiceClient<TCommand, TEvent, TResult> {
  return new WorkerServiceClient<TCommand, TEvent, TResult>({
    entry: resolveServiceEntry(`${name}-entry`),
    serviceName: name,
    onStopProgress: (event) => reportStopProgress(options.probe, event),
    ...options,
  })
}

function reportStopProgress(
  probe: NeemTestProbe | undefined,
  event: WorkerServiceStopProgressEvent,
): void {
  probe?.emit(`service:stop-${event.phase}`, event)
  switch (event.phase) {
    case 'slow':
      process.stderr.write(
        `Neem ${event.serviceName} service worker still stopping after ${event.elapsedMs}ms\n`,
      )
      return
    case 'timeout':
      process.stderr.write(
        `Neem ${event.serviceName} service stop timed out after ${event.timeoutMs}ms; terminating worker\n`,
      )
      return
    case 'complete': {
      const action = event.exited ? 'stopped' : 'did not stop'
      process.stderr.write(
        `Neem ${event.serviceName} service worker ${action} after ${event.elapsedMs}ms\n`,
      )
    }
  }
}
