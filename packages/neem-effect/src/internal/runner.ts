import type { RuntimeSnapshot } from '@nmtjs/neem/internal/manifest/snapshot'
import type {
  NeemRuntimePlan,
  NeemRuntimeThreadHandle,
} from '@nmtjs/neem/internal/shared/types'
import { deserializeError } from '@nmtjs/neem/internal/utils'
import * as Effect from 'effect/Effect'

import type { Deadline, Lifetime } from './lifetime.ts'
import type { RunnerWorkerData } from './protocol.ts'
import type { SpawnedWorker, WorkerRegistry } from './transport.ts'
import { hostSettings } from './config.ts'
import { requestError } from './context.ts'
import { RunnerRpcs } from './protocol.ts'
import { spawnWorker } from './transport.ts'

export type HostRunnerOptions = {
  snapshot: RuntimeSnapshot
  data: RunnerWorkerData
  env: NodeJS.ProcessEnv
  registry: WorkerRegistry
  /** Reports only; the runtime decides what a failure means. */
  onFailure: (error: Error) => void
}

const LABEL = 'Neem host runner'

/**
 * The worker running a runtime's planner and host. Closing the lifetime it
 * was started in shuts it down; stopping the user's host before the threads
 * is a separate step, `stopHost`.
 */
export class HostRunner {
  private readonly worker: SpawnedWorker<RunnerRpcs>
  private readonly requestTimeout: number
  private failed = false

  private constructor(
    worker: SpawnedWorker<RunnerRpcs>,
    requestTimeout: number,
  ) {
    this.worker = worker
    this.requestTimeout = requestTimeout
  }

  static start(
    lifetime: Lifetime,
    options: HostRunnerOptions,
  ): Effect.Effect<HostRunner, Error> {
    let runner: HostRunner | undefined
    return hostSettings(options.env).pipe(
      Effect.flatMap((settings) =>
        spawnWorker(lifetime, {
          label: LABEL,
          entry: options.snapshot.runnerEntry,
          workerData: options.data,
          env: options.env,
          group: RunnerRpcs,
          tracing: settings.tracing,
          registry: options.registry,
          describeFatal: deserializeError,
          onFailure: (error) => {
            if (runner) runner.failed = true
            options.onFailure(error)
          },
          requestExit: (client, timeoutMs) =>
            client.shutdown({ timeoutMs }, { discard: true }),
        }).pipe(
          Effect.map((worker) => {
            runner = new HostRunner(worker, settings.requestTimeout)
            return runner
          }),
        ),
      ),
    )
  }

  plan(): Effect.Effect<NeemRuntimePlan, Error> {
    return this.request('plan', this.worker.client.plan(), this.requestTimeout)
  }

  start(
    threads: readonly NeemRuntimeThreadHandle[],
  ): Effect.Effect<void, Error> {
    return this.request(
      'start',
      this.worker.client.start({ threads }),
      this.requestTimeout,
    )
  }

  /** Stops the user's host, bounded by the request timeout and the deadline. */
  stopHost(deadline: Deadline): Effect.Effect<void, Error> {
    if (this.failed) return Effect.void
    return this.request(
      'stop',
      this.worker.client.stop(),
      Math.min(this.requestTimeout, deadline.remaining()),
    )
  }

  private request<A, E extends Parameters<typeof requestError>[0]>(
    type: string,
    effect: Effect.Effect<A, E>,
    timeoutMs: number,
  ): Effect.Effect<A, Error> {
    return effect.pipe(
      Effect.mapError(requestError),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new Error(
              `${LABEL} request [${type}] timed out after ${timeoutMs}ms`,
            ),
          ),
      }),
    )
  }
}
