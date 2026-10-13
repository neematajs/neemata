import { hostname } from 'node:os'

import type { NeemRuntimeWorkerContext } from '@nmtjs/neem'
import type { ShardingConfig } from 'effect/cluster'
import type * as Crypto from 'effect/Crypto'
import type * as Duration from 'effect/Duration'
import type { SqlClient } from 'effect/sql'
import type { WorkflowEngine } from 'effect/workflow'
import { defineEffectWorker } from '@nmtjs/effect/neem/worker'
import { createRuntime, defineRuntimePlanner } from '@nmtjs/neem'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type { Known } from './sql.ts'
import { layerCatalog, layerSql } from './sql.ts'

export type PoolConfig = {
  /** Worker threads, each one a cluster runner serving this pool. */
  readonly threads?: number
  /** Share of the pool's shards each of its runners takes; 1 by default. */
  readonly weight?: number
}

/** The thread layout: which pools exist and how many runners serve each. */
export type NativeWorkflowsPlan = {
  readonly pools: Readonly<Record<string, PoolConfig>>
}

export type NativeWorkerData = {
  readonly pool: string
  /** Position among all planned threads; it is part of the runner identity. */
  readonly slot: number
  readonly weight: number
  /** Every planned pool. All runners must agree on this list. */
  readonly pools: readonly string[]
}

export const createNativeWorkflowsRuntime = createRuntime({})

/**
 * Plans one worker thread per runner. There is no coordinator role: the
 * engine in each runner advances the executions whose shards it owns.
 */
export function defineNativeWorkflowsPlanner(
  factory: () => NativeWorkflowsPlan | Promise<NativeWorkflowsPlan>,
) {
  return defineRuntimePlanner<undefined, NativeWorkerData>(async () => {
    const plan = await factory()
    const pools = Object.keys(plan.pools)
    if (pools.length === 0) {
      throw new Error('Native workflows planner must declare at least one pool')
    }

    const workers: NativeWorkerData[] = []
    for (const [pool, config] of Object.entries(plan.pools)) {
      const { threads = 1, weight = 1 } = config
      if (!Number.isInteger(threads) || threads < 1) {
        throw new Error(
          `Invalid thread count for native workflows pool [${pool}]: expected positive integer, received ${threads}`,
        )
      }

      for (let thread = 0; thread < threads; thread++) {
        workers.push({ pool, pools, weight, slot: workers.length })
      }
    }

    return { workers, options: undefined }
  })
}

type Context = NeemRuntimeWorkerContext<NativeWorkerData, undefined>

export type NativeWorkflowsWorker<R> = {
  /** Every definition of the deployment, including ones other pools execute. */
  readonly definitions: Iterable<Known<R>>
  /** Handlers for the definitions placed in `pool`. */
  readonly handlers: (
    pool: string,
  ) => Layer.Layer<never, never, WorkflowEngine.WorkflowEngine | R>
  /**
   * The database client, `Crypto` and whatever the handlers and the
   * definitions' result schemas require. Built once per worker generation and
   * released after the engine has stopped.
   */
  readonly layer: (
    ctx: Context,
  ) => Layer.Layer<R | SqlClient.SqlClient | Crypto.Crypto, unknown>
  readonly engine?: {
    readonly prefix?: string
    /**
     * Names this Neem process to the cluster; the machine's hostname by
     * default. Two processes on one machine that share a database and prefix
     * must be given different names.
     */
    readonly host?: string
    readonly pollInterval?: Duration.Input
    /** Keep below Neem's stop timeout, which also covers `layer` teardown. */
    readonly terminationTimeout?: Duration.Input
    readonly sharding?: Partial<ShardingConfig.ShardingConfig['Service']>
  }
}

/**
 * A Neem worker thread that runs as one cluster runner for its pool. Neem
 * owns the thread's lifetime: stopping it interrupts the engine, which hands
 * unfinished executions to another runner.
 */
export function defineNativeWorkflowsWorker<R = never>(
  worker: NativeWorkflowsWorker<R>,
) {
  return defineEffectWorker((ctx: Context) => {
    const { pool, pools, slot, weight } = ctx.data
    const host = worker.engine?.host ?? hostname()

    const engine = layerSql({
      ...worker.engine,
      pools,
      runner: { host, slot, weight, pools: [pool] },
    })
    const layer = Layer.mergeAll(
      layerCatalog(worker.definitions),
      worker.handlers(pool),
    ).pipe(Layer.provideMerge(engine), Layer.provideMerge(worker.layer(ctx)))

    return {
      layer,
      // The engine works in the background of its layer; the thread is ready
      // once that layer is built and stays up until Neem stops it.
      main: (ready) => ready().pipe(Effect.andThen(Effect.never)),
    }
  })
}
