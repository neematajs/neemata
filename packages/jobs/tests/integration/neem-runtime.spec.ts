import type { MessagePort as NodeMessagePort } from 'node:worker_threads'
import { MessageChannel } from 'node:worker_threads'

import type {
  NeemRuntimePlannerContext,
  NeemRuntimeThreadHandle,
} from '@nmtjs/neem'
import { createLogger } from '@nmtjs/core'
import { createJob } from '@nmtjs/jobs'
import { createJobsRuntime, defineJobsPlanner } from '@nmtjs/jobs/neem'
import { t } from '@nmtjs/type'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobsServiceTarget } from './helpers.ts'
import jobsHostFactory from '../../src/neem/host.ts'
import {
  createTestLogger,
  createTestName,
  requireServiceEnv,
  serviceTargets,
  wait,
} from './helpers.ts'

const workerReadyGate = createDeferred<void>()
const workerWaitObserved = createDeferred<void>()

vi.mock('bullmq', async (importOriginal) => {
  const bullmq = await importOriginal<typeof import('bullmq')>()

  return {
    ...bullmq,
    Worker: class ControlledWorker extends bullmq.Worker {
      override async waitUntilReady() {
        workerWaitObserved.resolve()
        await workerReadyGate.promise
        return await super.waitUntilReady()
      }
    },
  }
})

describe('@nmtjs/jobs Neem runtime helpers', () => {
  it('declares a jobs runtime with package-owned host and caller worker entry', () => {
    const defineRuntime = createJobsRuntime()
    const runtime = defineRuntime({
      name: 'jobs',
      planner: './jobs.planner.ts',
      worker: { entry: './jobs.worker.ts' },
    })

    expect(runtime).toMatchObject({
      name: 'jobs',
      planner: './jobs.planner.ts',
      host: { entry: '@nmtjs/jobs/neem/host' },
      worker: { entry: './jobs.worker.ts' },
    })
  })

  it('plans one worker group per configured pool', async () => {
    const fastJob = createJob({
      name: 'fast-job',
      pool: 'fast',
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
    }).return(({ input }) => input)
    const slowJob = createJob({
      name: 'slow-job',
      pool: 'slow',
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
    }).return(({ input }) => input)
    const factory = () => ({
      client: () => {
        throw new Error('planner must not open jobs client')
      },
      pools: { fast: { threads: 2, jobs: 4 }, slow: { threads: 1, jobs: 1 } },
      jobs: () => [fastJob, slowJob],
    })
    const planner = defineJobsPlanner(factory)

    const plan = await planner(plannerContext)

    expect(plan.workers).toEqual({
      fast: [{ poolName: 'fast' }, { poolName: 'fast' }],
      slow: [{ poolName: 'slow' }],
    })
    expect(plan.options).toBe(factory)
  })
})

for (const target of serviceTargets) {
  requireServiceEnv(target)

  describe.skipIf(!target.url)(
    `@nmtjs/jobs Neem host ${target.name} integration`,
    () => {
      const ports: NodeMessagePort[] = []
      const hosts: Awaited<ReturnType<typeof jobsHostFactory>>[] = []

      beforeEach(() => {
        workerReadyGate.reset()
        workerWaitObserved.reset()
      })

      afterEach(async () => {
        await Promise.allSettled(hosts.splice(0).map((host) => host.stop?.()))
        for (const port of ports.splice(0)) port.close()
        workerReadyGate.reset()
        workerWaitObserved.reset()
      })

      it('does not resolve start until queue workers are ready', async () => {
        const job = createJob({
          name: createTestName('neem-host-ready-job'),
          pool: 'default',
          input: t.object({ value: t.string() }),
          output: t.object({ value: t.string() }),
        }).return(({ input }) => input)
        const channel = new MessageChannel()
        ports.push(channel.port1, channel.port2)
        const host = await jobsHostFactory({
          mode: 'development',
          name: 'jobs',
          logger: createTestLogger('jobs-neem-host-ready'),
          threads: [
            { name: 'jobs:default:0', port: channel.port1 },
          ] satisfies NeemRuntimeThreadHandle[],
          options: () => ({
            client: target.createClient,
            pools: { default: { threads: 1, jobs: 1 } },
            jobs: () => [job],
          }),
        })
        hosts.push(host)

        let startResolved = false
        const startPromise = Promise.resolve(host.start!()).then(() => {
          startResolved = true
        })

        await expect(
          Promise.race([
            startPromise.then(() => 'resolved'),
            workerWaitObserved.promise.then(() => 'waiting'),
          ]),
        ).resolves.toBe('waiting')
        await wait(10)
        expect(startResolved).toBe(false)

        workerReadyGate.resolve()
        await expect(startPromise).resolves.toBeUndefined()
        expect(startResolved).toBe(true)
      })
    },
  )
}

const plannerContext = {
  mode: 'development',
  name: 'jobs',
  logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
} satisfies NeemRuntimePlannerContext

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  let promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return {
    get promise() {
      return promise
    },
    resolve(value: T) {
      resolve(value)
    },
    reject(reason?: unknown) {
      reject(reason)
    },
    reset() {
      promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve
        reject = promiseReject
      })
    },
  }
}
