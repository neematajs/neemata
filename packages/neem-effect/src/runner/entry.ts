import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type {
  NeemRuntimeHost,
  NeemRuntimeHostFactory,
  NeemRuntimePlan,
  NeemRuntimePlanner,
  NeemRuntimeThreadHandle,
} from '@nmtjs/neem/internal/shared/types'
import type { Logger } from 'pino'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import { isNeemRuntimeHostFactory, isNeemRuntimePlanner } from '@nmtjs/neem'
import {
  childLogger,
  resolveManifestLogger,
  runtimeLabel,
} from '@nmtjs/neem/internal/logger'
import { importDefault } from '@nmtjs/neem/internal/utils'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as RpcServer from 'effect/rpc/RpcServer'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import type { RunnerWorkerData } from '../internal/protocol.ts'
import { hostSettings } from '../internal/config.ts'
import { attempt, causeErrors, Deadline, within } from '../internal/lifetime.ts'
import { RunnerRpcs } from '../internal/protocol.ts'
import { WorkerExit } from '../internal/worker-exit.ts'

const LABEL = 'Neem host'
const data = rawWorkerData as RunnerWorkerData
let threads: readonly NeemRuntimeThreadHandle[] = []
const closeThreads = () => {
  for (const thread of threads) thread.port.close()
  threads = []
}
const exit = new WorkerExit(parentPort, closeThreads)

const logger = Deferred.makeUnsafe<Logger, Error>()
// The user's runtime host lives here; stopping closes it, including a host
// whose factory resolves only after the stop.
const hostScope = Scope.makeUnsafe()
// Planning and starting each run once per generation, never side by side.
const serial = Semaphore.makeUnsafe(1)
let plannerOptions: unknown
let starting: Fiber.Fiber<void, Error> | undefined
let stopped = false
let stopping: Fiber.Fiber<void, Error> | undefined

const plan = Effect.gen(function* () {
  const log = yield* Deferred.await(logger)
  log.trace('Calling Neem runtime planner')
  const file = data.plannerArtifact.file
  const planner = yield* attempt(() => importDefault<NeemRuntimePlanner>(file))
  if (!isNeemRuntimePlanner(planner)) {
    return yield* Effect.fail(
      new Error(
        `Runtime planner file [${file}] default export must be a marked runtime planner produced by defineRuntimePlanner or a package planner helper`,
      ),
    )
  }
  const result = yield* attempt(() =>
    planner({ mode: data.mode, name: data.runtimeName, logger: log }),
  )
  if (!result || !('workers' in result)) {
    return yield* Effect.fail(
      new Error(`Runtime planner file [${file}] must return workers`),
    )
  }
  plannerOptions = result.options
  return { workers: result.workers } satisfies NeemRuntimePlan
})

const createHost = Effect.gen(function* () {
  const log = yield* Deferred.await(logger)
  const file = data.hostArtifact.file
  const factory = yield* attempt(() =>
    importDefault<NeemRuntimeHostFactory>(file),
  )
  if (!isNeemRuntimeHostFactory(factory)) {
    return yield* Effect.fail(
      new Error(
        `Runtime host file [${file}] default export must be a marked runtime host factory produced by defineRuntimeHost`,
      ),
    )
  }
  log.trace({ threads: threads.length }, 'Calling Neem runtime host start')
  const host = yield* Effect.acquireRelease(
    attempt(() =>
      factory({
        mode: data.mode,
        name: data.runtimeName,
        logger: log,
        threads,
        options: plannerOptions,
      }),
    ),
    (host: NeemRuntimeHost) => attempt(() => host.stop?.()).pipe(Effect.orDie),
  ).pipe(Scope.provide(hostScope))
  if (stopped) {
    return yield* Effect.fail(
      new Error('Neem runtime host stopped before start'),
    )
  }
  yield* attempt(() => host.start?.())
})

const start = (handles: readonly NeemRuntimeThreadHandle[]) =>
  Effect.gen(function* () {
    if (stopped) {
      return yield* Effect.fail(
        new Error('Neem runtime host stopped before start'),
      )
    }
    threads = handles
    const fiber = yield* Effect.forkIn(createHost, hostScope)
    starting = fiber
    return yield* Fiber.join(fiber)
  })

// Joins a start still creating the host, so the host it yields is stopped
// exactly once; an earlier stop that hangs is the parent's to abandon.
const stopHost = Effect.gen(function* () {
  stopped = true
  if (starting) yield* Fiber.interrupt(starting)
  const closed = yield* Effect.exit(Scope.close(hostScope, Exit.void))
  closeThreads()
  if (Exit.isFailure(closed)) {
    const [error] = causeErrors(closed.cause)
    if (error) return yield* Effect.fail(error)
  }
})

const stop = Effect.gen(function* () {
  stopping ??= yield* Effect.forkDetach(stopHost)
  return yield* Fiber.join(stopping)
})

const handlers = RunnerRpcs.toLayer({
  plan: () => serial.withPermit(plan),
  start: ({ threads }) => serial.withPermit(start(threads)),
  stop: () => stop,
  shutdown: ({ timeoutMs }) =>
    Effect.gen(function* () {
      // The host's wait for the exit began when it sent this.
      const deadline = yield* Deadline.make(timeoutMs)
      exit.logger?.trace('Neem host runner shutting down')
      // Without an earlier stop, a host still being created would outlive
      // the runner.
      if (!stopping) yield* within(Effect.ignore(stop), deadline)
      return yield* Effect.promise(() => exit.exit(0, deadline.remaining()))
    }),
})

exit.installCrashHandlers(LABEL)
resolveManifestLogger(data.logger, {
  mode: data.mode,
  outDir: data.outDir,
}).then(
  (resolved) => {
    const log = childLogger(resolved, runtimeLabel(data.runtimeName, 'host'))
    exit.logger = log
    log.trace(
      {
        hostArtifactId: data.hostArtifact.id,
        plannerArtifactId: data.plannerArtifact.id,
      },
      'Neem host runner initialized',
    )
    Deferred.doneUnsafe(logger, Effect.succeed(log))
  },
  (error: unknown) => {
    exit.reportFatal(error, 'bootstrap', LABEL)
    void exit.exit(1)
  },
)
Effect.runFork(
  hostSettings(process.env).pipe(
    Effect.flatMap((settings) =>
      Layer.launch(
        RpcServer.layer(RunnerRpcs, {
          disableTracing: !settings.tracing,
          disableFatalDefects: true,
        }).pipe(
          Layer.provide(handlers),
          Layer.provide(RpcServer.layerProtocolWorkerRunner),
          Layer.provide(NodeWorkerRunner.layer),
        ),
      ),
    ),
  ),
)
