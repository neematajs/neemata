import { bench, describe } from 'vitest'

import type { InMemoryWorkflowRuntime } from '../src/runtime/index.ts'
import {
  createInMemoryWorkflowRuntime,
  itemChildKey,
} from '../src/runtime/index.ts'

const CREATE_ITERATIONS = 10_000
const WARMUP_ITERATIONS = 1_000
const FANOUTS_PER_SAMPLE = 200
const FANOUT_ITERATIONS = 3_000
const FANOUT_WARMUP_ITERATIONS = 300

const runInput = Object.freeze({
  workflowName: 'benchmark-workflow',
  input: Object.freeze({ caseId: 'case-0001', revision: 17 }),
  tags: Object.freeze({ suite: 'runtime-benchmark' }),
})

const fanoutChildren = Object.freeze(
  Array.from({ length: 16 }, (_, index) => ({
    childKey: itemChildKey(index),
    kind: 'activity' as const,
    ordinal: index,
    itemKey: `case-${index.toString().padStart(2, '0')}`,
    item: Object.freeze({ index, value: index * 3 }),
  })),
)

let createRuntime = createInMemoryWorkflowRuntime()
let startRuntime = createInMemoryWorkflowRuntime()
let transitionRuntime = createInMemoryWorkflowRuntime()
let transitionRunIds: string[] = []
let transitionIndex = 0
let fanoutRuntimes: InMemoryWorkflowRuntime[] = []
let fanoutRunIds: string[][] = []
let fanoutIndex = 0

async function prepareRuns(
  runtime: InMemoryWorkflowRuntime,
  count: number,
  withNode = false,
) {
  const runIds: string[] = []
  for (let index = 0; index < count; index += 1) {
    const run = await runtime.store.createRun(runInput)
    runIds.push(run.id)
    if (withNode) {
      await runtime.store.createNode({
        runId: run.id,
        name: 'fanout',
        kind: 'parallel',
      })
    }
  }
  return runIds
}

describe('deterministic in-memory workflow runtime', () => {
  bench(
    'create run',
    async () => {
      await createRuntime.store.createRun(runInput)
    },
    {
      time: 0,
      warmupTime: 0,
      iterations: CREATE_ITERATIONS,
      warmupIterations: WARMUP_ITERATIONS,
      setup: () => {
        createRuntime = createInMemoryWorkflowRuntime()
      },
    },
  )

  bench(
    'atomic workflow start',
    async () => {
      await startRuntime.atomicStart.startWorkflowRun({ run: runInput })
    },
    {
      time: 0,
      warmupTime: 0,
      iterations: CREATE_ITERATIONS,
      warmupIterations: WARMUP_ITERATIONS,
      setup: () => {
        startRuntime = createInMemoryWorkflowRuntime()
      },
    },
  )

  bench(
    'queued to running transition',
    async () => {
      await transitionRuntime.store.markRunRunning({
        runId: transitionRunIds[transitionIndex++]!,
      })
    },
    {
      time: 0,
      warmupTime: 0,
      iterations: CREATE_ITERATIONS,
      warmupIterations: WARMUP_ITERATIONS,
      setup: async (_task, mode) => {
        const iterations =
          mode === 'warmup' ? WARMUP_ITERATIONS : CREATE_ITERATIONS
        transitionRuntime = createInMemoryWorkflowRuntime()
        transitionRunIds = await prepareRuns(transitionRuntime, iterations)
        transitionIndex = 0
      },
    },
  )

  bench(
    `create ${FANOUTS_PER_SAMPLE} 16-way map fanouts`,
    async () => {
      const index = fanoutIndex++
      const runtime = fanoutRuntimes[index]!
      for (const runId of fanoutRunIds[index]!) {
        await runtime.store.ensureNodeChildren({
          runId,
          nodeName: 'fanout',
          children: fanoutChildren,
        })
      }
    },
    {
      time: 0,
      warmupTime: 0,
      iterations: FANOUT_ITERATIONS,
      warmupIterations: FANOUT_WARMUP_ITERATIONS,
      setup: async (_task, mode) => {
        const count =
          mode === 'warmup' ? FANOUT_WARMUP_ITERATIONS : FANOUT_ITERATIONS
        fanoutRuntimes = Array.from({ length: count }, () =>
          createInMemoryWorkflowRuntime(),
        )
        fanoutRunIds = []
        for (const runtime of fanoutRuntimes) {
          fanoutRunIds.push(
            await prepareRuns(runtime, FANOUTS_PER_SAMPLE, true),
          )
        }
        fanoutIndex = 0
      },
    },
  )
})
