import type { TransferListItem } from 'node:worker_threads'
import { Worker as NodeWorker } from 'node:worker_threads'

import type * as Rpc from 'effect/rpc/Rpc'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type {
  FromClientEncoded,
  FromServerEncoded,
} from 'effect/rpc/RpcMessage'
import { exitBudget } from '@nmtjs/neem/internal/host/lifecycle'
import { normalizeError } from '@nmtjs/neem/internal/utils'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as RpcClient from 'effect/rpc/RpcClient'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Worker from 'effect/workers/Worker'
import { WorkerError, WorkerReceiveError } from 'effect/workers/WorkerError'

import type { Lifetime } from './lifetime.ts'
import type { WorkerFatal } from './protocol.ts'
import { within } from './lifetime.ts'
import { FATAL_FRAME } from './protocol.ts'

/**
 * Every Node worker the host has running. A stop that runs out of budget
 * terminates whatever is still here, even when a release is stuck elsewhere.
 */
export class WorkerRegistry {
  private readonly workers = new Set<NodeWorker>()

  add(worker: NodeWorker): void {
    this.workers.add(worker)
    worker.once('exit', () => this.workers.delete(worker))
  }

  get size(): number {
    return this.workers.size
  }

  async terminateAll(): Promise<void> {
    await Promise.all(
      [...this.workers].map((worker) => worker.terminate().catch(() => 0)),
    )
  }
}

export type SpawnWorkerOptions<Rpcs extends Rpc.Any> = {
  /** Names the worker in errors, e.g. `Worker [api:0]`. */
  label: string
  tracing?: boolean
  entry: string
  workerData: unknown
  transferList?: readonly TransferListItem[]
  env: NodeJS.ProcessEnv
  group: RpcGroup.RpcGroup<Rpcs>
  registry: WorkerRegistry
  /** Turns the worker's own failure report into the error the host sees. */
  describeFatal: (fatal: WorkerFatal) => Error
  /**
   * Reports a failure while the worker is in service: its fatal report, an
   * error event, or an exit nobody asked for. Called at most once, and never
   * once its release began; a failure then fails the release instead.
   */
  onFailure: (error: Error) => void
  /** Called when the worker exits, for whatever reason. */
  onExit?: (code: number) => void
  /** Asks the worker to exit; its exit is the acknowledgement. */
  requestExit: (
    client: RpcClient.RpcClient<Rpcs, RpcClientError>,
    timeoutMs: number,
  ) => Effect.Effect<void, unknown>
}

export type SpawnedWorker<Rpcs extends Rpc.Any> = {
  readonly client: RpcClient.RpcClient<Rpcs, RpcClientError>
  /** Resolves with the exit code. */
  readonly exited: Deferred.Deferred<number>
}

/**
 * Starts a Node worker owned by `lifetime` and an RPC client for it. Closing
 * the lifetime asks the worker to exit, fails requests still waiting, then
 * waits for the exit until the lifetime's deadline and terminates the worker
 * after it. The release fails when the worker reported an error first or had
 * to be terminated.
 *
 * There is no reconnect or respawn here: a dead worker is a failure for its
 * owner to handle.
 */
export const spawnWorker = <Rpcs extends Rpc.Any>(
  lifetime: Lifetime,
  options: SpawnWorkerOptions<Rpcs>,
): Effect.Effect<SpawnedWorker<Rpcs>> =>
  Effect.gen(function* () {
    const exited = Deferred.makeUnsafe<number>()
    let releasing = false
    let reported: Error | undefined
    // A failure after the release began fails the release instead.
    let stopError: Error | undefined
    const fail = (error: Error) => {
      if (releasing) {
        stopError ??= error
        return
      }
      if (reported) return
      reported = error
      options.onFailure(error)
    }

    // Registered before native acquisition, so the receive loop outlives the
    // native worker's graceful exit. Reversing these scopes drops a stop that
    // Worker.makePlatform buffered while waiting for its ready handshake.
    const receiveLifetime = lifetime.fork()
    const installed = Deferred.makeUnsafe<void>()
    let transportError: Error | undefined
    const platform = Worker.makePlatform<NodeWorker>()({
      setup: ({ worker }) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            options.registry.add(worker)
            // Fatal reports stay synchronous and outside response-handler fibers:
            // Node delivers them before exit, even when the worker exits at once.
            worker.on('message', (frame: unknown) => {
              if (isFrame(frame, FATAL_FRAME))
                fail(options.describeFatal(frame[1] as WorkerFatal))
            })
            worker.on('error', fail)
            worker.on('messageerror', fail)
            worker.on('exit', (code) => {
              Deferred.doneUnsafe(exited, Effect.succeed(code))
              options.onExit?.(code)
              if (!releasing)
                fail(new Error(`${options.label} exited with code [${code}]`))
            })
            return worker
          }),
          (worker) =>
            Effect.gen(function* () {
              const deadline = lifetime.deadline()
              const budget = deadline.remaining()
              const exit = yield* within(Deferred.await(exited), deadline)
              if (Option.isNone(exit)) {
                yield* Effect.promise(() => worker.terminate().catch(() => 0))
                return yield* Effect.die(
                  new Error(
                    `${options.label} did not stop within ${Math.round(budget)}ms and was terminated`,
                  ),
                )
              }
              if (stopError) return yield* Effect.die(stopError)
            }),
        ).pipe(
          Scope.provide(lifetime.scope),
          Effect.tap(() => Deferred.succeed(installed, undefined)),
        ),
      listen: ({ port, emit, deferred, scope }) => {
        const onMessage = (frame: unknown) => {
          // Frame 2 is Neem's synchronous fatal report, not an Effect response.
          if (Array.isArray(frame) && (frame[0] === 0 || frame[0] === 1))
            emit(frame)
        }
        const onError = (cause: Error) =>
          Deferred.doneUnsafe(
            deferred,
            Effect.fail(
              new WorkerError({
                reason: new WorkerReceiveError({
                  message: cause.message,
                  cause,
                }),
              }),
            ),
          )
        const onExit = (code: number) =>
          onError(new Error(`${options.label} exited with code [${code}]`))
        return Effect.sync(() => {
          port.on('message', onMessage)
          port.on('error', onError)
          port.on('messageerror', onError)
          port.on('exit', onExit)
        }).pipe(
          Effect.andThen(
            Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                port.off('message', onMessage)
                port.off('error', onError)
                port.off('messageerror', onError)
                port.off('exit', onExit)
              }),
            ),
          ),
        )
      },
    })
    const backing = yield* platform
      .spawn<FromServerEncoded, FromClientEncoded>(0)
      .pipe(
        Effect.provideService(
          Worker.Spawner,
          () =>
            new NodeWorker(options.entry, {
              workerData: options.workerData,
              transferList: options.transferList as
                | TransferListItem[]
                | undefined,
              env: options.env,
            }),
        ),
        Effect.orDie,
      )
    const protocol = yield* RpcClient.Protocol.make(
      Effect.fnUntraced(function* (writeResponse, clientIds) {
        const broadcast = (response: Parameters<typeof writeResponse>[1]) =>
          Effect.forEach(clientIds, (id) => writeResponse(id, response), {
            discard: true,
          })
        const failure = (message: string, cause: unknown) =>
          new RpcClientError({
            reason: new RpcClientDefect({ message, cause }),
          })
        yield* backing.run(broadcast).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void
            transportError = normalizeError(Cause.squash(cause))
            if (!releasing) fail(transportError)
            return broadcast({
              _tag: 'ClientProtocolError',
              error: failure(
                `${options.label} transport failed`,
                reported ?? transportError,
              ),
            })
          }),
          // A spawn/setup failure must also unblock acquisition. Future sends
          // fail below rather than buffering forever on a receive loop that ended.
          Effect.ensuring(Deferred.succeed(installed, undefined)),
          Effect.forkIn(receiveLifetime.scope, { startImmediately: true }),
        )
        yield* Deferred.await(installed)
        return {
          send: (_clientId, request, transfers) =>
            Effect.suspend(() => {
              if (Deferred.isDoneUnsafe(exited) || transportError) {
                return Effect.fail(
                  failure(
                    `${options.label} is not running`,
                    reported ?? transportError,
                  ),
                )
              }
              return backing
                .send(request, transfers)
                .pipe(
                  Effect.mapError((cause) =>
                    failure(`Failed to send to ${options.label}`, cause),
                  ),
                )
            }),
          supportsAck: true,
          supportsTransferables: true,
          codecFor: Schema.toCodecJson,
        }
      }),
    )
    const client = yield* RpcClient.make(options.group, {
      disableTracing: !options.tracing,
    }).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
      Scope.provide(lifetime.scope),
    )

    // Registered last, so it runs first: the request goes out before the
    // client shuts down and fails whatever is still waiting.
    yield* Scope.addFinalizer(
      lifetime.scope,
      Effect.suspend(() => {
        releasing = true
        if (Deferred.isDoneUnsafe(exited)) return Effect.void
        const timeoutMs = exitBudget(lifetime.deadline().remaining())
        return options.requestExit(client, timeoutMs).pipe(Effect.ignore)
      }),
    )

    return { client, exited }
  })

function isFrame(
  frame: unknown,
  type: number,
): frame is readonly [number, unknown] {
  return Array.isArray(frame) && frame[0] === type
}
