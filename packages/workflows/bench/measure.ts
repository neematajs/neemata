import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, loadavg, tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import {
  setImmediate as immediate,
  setTimeout as sleep,
} from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import type { Concurrency, Engine, Target } from './engine.ts'
import type { Counts } from './proxy.ts'
import type { Count, Workload } from './workloads.ts'
import { engine as connect } from './engine.ts'
import { countingProxy } from './proxy.ts'
import { calls, handlerCalls } from './workloads.ts'

/** One workload at one size: what the engine is given, and how. */
export type Spec = {
  readonly id: string
  readonly title: string
  readonly workload: Workload
  readonly input: Count
  /** Runs started before any worker runs, so all are in flight at once. */
  readonly runs: number
  /** Without workers the sample ends when the runs are started. */
  readonly workers?: Concurrency
  readonly timeoutMs: number
  /**
   * Whether the warm-up round runs it. The largest maps are not warmed up on
   * their own: the smaller ones before them run the same code.
   */
  readonly warmup: boolean
  /** Fewer measured rounds than the others, for a spec that takes minutes. */
  readonly rounds?: number
}

const eight = { coordinator: 8, execution: 8 }
// The map bounds its items at 16, so the worker must not bound them lower.
const mapping = { coordinator: 8, execution: 16 }
const batch = (
  id: string,
  workload: Workload,
  runs: number,
  what: string,
  workers?: Concurrency,
): Spec => ({
  id,
  title: `${what}, ${runs.toLocaleString('en-US')} runs${
    workers ? `, concurrency ${workers.coordinator}` : ', no workers'
  }`,
  workload,
  input: { n: 0 },
  runs,
  ...(workers ? { workers } : {}),
  timeoutMs: 300_000,
  warmup: true,
})
const map = (
  n: number,
  timeoutMs: number,
  warmup = true,
  rounds?: number,
): Spec => ({
  id: `map-${n}`,
  title: `mapTask over ${n.toLocaleString('en-US')} items, 1 run`,
  workload: 'map',
  input: { n },
  runs: 1,
  workers: mapping,
  timeoutMs,
  warmup,
  ...(rounds === undefined ? {} : { rounds }),
})

/**
 * The workloads. `scale` multiplies the runs of every batch: an in-memory
 * batch is over in milliseconds unless it is larger.
 */
export const specs = (scale: number): readonly Spec[] => [
  batch('start', 'sequential', 500 * scale, 'start'),
  batch('sequential-c1', 'sequential', 100 * scale, '5 activities', {
    coordinator: 1,
    execution: 1,
  }),
  batch('sequential-c8', 'sequential', 100 * scale, '5 activities', eight),
  batch('tasks', 'tasks', 50 * scale, '5 task steps', eight),
  batch('parallel', 'parallel', 50 * scale, 'parallel of 8 activities', eight),
  map(10, 60_000),
  map(100, 60_000),
  map(1_000, 300_000, false),
  // Minutes a sample on a server: three rounds say as much as five.
  map(5_000, 300_000, false, 3),
  batch(
    'children',
    'children',
    5 * scale,
    'parents of 20 child workflows of 3 activities',
    eight,
  ),
  // As many runs at every scale: this one is about 500 in flight at once.
  batch('many', 'sequential', 500, '5 activities, all in flight', eight),
]

/** Starts of a batch that are in flight at once. */
const START_CONCURRENCY = 8

export type Sample = {
  /** Starting the runs. */
  readonly startMs: number
  /** From the workers' start to the last run's end; absent without workers. */
  readonly workMs?: number
  /** CPU the process used while the workers worked, user and system. */
  readonly cpuMs?: number
  /** What crossed the wire, when the engine is reached through a proxy. */
  readonly started?: Counts
  readonly worked?: Counts
  /** What the workers reported as errors while they worked. */
  readonly errors?: readonly string[]
}

async function pooled<A, B>(
  items: readonly A[],
  concurrency: number,
  run: (item: A) => Promise<B>,
): Promise<B[]> {
  const results = Array.from<B>({ length: items.length })
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await run(items[index]!)
      }
    }),
  )
  return results
}

/** What a sample that did not finish had done when it was given up. */
export type Unfinished = {
  readonly message: string
  readonly afterMs: number
  /** Handler calls made, of those the batch needs. */
  readonly handled: number
  readonly total: number
  readonly worked?: Counts
  readonly errors?: readonly string[]
}

/** A sample out of time: the engine is slow, not wrong. */
class Stuck extends Error {
  constructor(public unfinished: Unfinished) {
    super(unfinished.message)
  }
}

/**
 * How long a counted sample may take of what did not finish in time. Its
 * counts per handled item say how the cost grows; finishing would only take
 * longer.
 */
const COUNT_BUDGET_MS = 120_000

function directory() {
  return resolve(
    process.env.BENCH_OUTPUT ?? resolve(tmpdir(), 'neemata-workflows-bench'),
  )
}

/**
 * Vitest shows what a test logs when it ends, and a store takes the better
 * part of an hour: progress goes to a file that can be followed meanwhile.
 */
function progress(line: string) {
  console.log(line)
  try {
    appendFileSync(
      resolve(directory(), 'progress.log'),
      `${new Date().toISOString()} ${line}\n`,
    )
  } catch {}
}

/**
 * One sample, on a store the caller has emptied with `engine.reset()`: the
 * runs started, then the workers until every run completed. The two phases
 * are timed and counted apart.
 */
export async function sample(
  engine: Engine,
  spec: Spec,
  take?: () => Counts,
): Promise<Sample> {
  const total = spec.runs * handlerCalls(spec.workload, spec.input)
  const handled = calls.expect(spec.workers ? total : 0)

  take?.()
  const startedAt = performance.now()
  const ids = await pooled(
    Array.from({ length: spec.runs }),
    START_CONCURRENCY,
    () => engine.start(spec.workload, spec.input),
  )
  const startMs = performance.now() - startedAt
  const started = take?.()
  if (!spec.workers) return { startMs, ...(started ? { started } : {}) }

  const cpu = process.cpuUsage()
  const workedAt = performance.now()
  const deadline = workedAt + spec.timeoutMs
  const stop = engine.serve(spec.workers)
  let stopped: Promise<readonly string[]> | undefined
  const halt = () => (stopped ??= stop())
  try {
    // Nothing reads the store before the last handler ran: until then no run
    // of the batch can have ended, and a read would be load on the server.
    const waited = new AbortController()
    await Promise.race([
      handled,
      sleep(spec.timeoutMs, undefined, { signal: waited.signal }).catch(
        () => {},
      ),
    ])
    waited.abort()
    while (await engine.active()) {
      if (performance.now() > deadline) {
        const worked = take?.()
        throw new Stuck({
          message: `did not finish [${spec.id}] in ${spec.timeoutMs} ms: ${calls.count}/${total} handler calls`,
          afterMs: performance.now() - workedAt,
          handled: calls.count,
          total,
          ...(worked ? { worked } : {}),
        })
      }
      // A server is asked once a millisecond; a store in the process answers
      // in microseconds, and a timer would be most of what is measured.
      await (engine.store === 'memory' ? immediate() : sleep(1))
    }
    const workMs = performance.now() - workedAt
    const used = process.cpuUsage(cpu)
    const worked = take?.()
    const errors = await halt()
    // Outside what is timed and counted: every run of the batch completed.
    const done = await pooled(ids, START_CONCURRENCY, engine.completed)
    if (done.includes(false)) {
      throw new Error(`left runs of [${spec.id}] unfinished`)
    }
    return {
      startMs,
      workMs,
      cpuMs: (used.user + used.system) / 1_000,
      ...(started ? { started } : {}),
      ...(worked ? { worked } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    }
  } catch (error) {
    const errors = await halt()
    if (error instanceof Stuck && errors.length > 0) {
      error.unfinished = { ...error.unfinished, errors }
    }
    throw error
  } finally {
    await halt()
  }
}

export type Idle = {
  readonly seconds: number
  readonly cpuMs: number
  readonly counts?: Counts
}

/** Workers with nothing to do, after they have settled into polling. */
async function idle(
  engine: Engine,
  seconds: number,
  take?: () => Counts,
): Promise<Idle> {
  await engine.reset()
  const stop = engine.serve(eight)
  try {
    // The sweeps a worker runs as it starts are not what idling costs.
    await sleep(2_000)
    take?.()
    const cpu = process.cpuUsage()
    const from = performance.now()
    await sleep(seconds * 1_000)
    const used = process.cpuUsage(cpu)
    const counts = take?.()
    return {
      seconds: (performance.now() - from) / 1_000,
      cpuMs: (used.user + used.system) / 1_000,
      ...(counts ? { counts } : {}),
    }
  } finally {
    await stop()
  }
}

export type Report = {
  readonly store: string
  readonly machine: ReturnType<typeof machine>
  readonly settings: {
    readonly rounds: number
    readonly countRounds: number
    readonly idleSeconds: number
  }
  readonly loadBefore: readonly number[]
  readonly loadAfter: readonly number[]
  readonly specs: readonly {
    readonly spec: Spec
    readonly timed: Sample[]
    readonly counted: Sample[]
    readonly failures: Record<'timed' | 'counted', Unfinished | undefined>
  }[]
  readonly idle?: Idle
}

/**
 * A hash of the engine's sources, so that a report says which state of it
 * was measured and two reports can be told apart.
 */
function sources() {
  const root = fileURLToPath(new URL('../src/', import.meta.url))
  const hash = createHash('sha256')
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .toSorted()
  for (const file of files) {
    hash.update(relative(root, file)).update(readFileSync(file))
  }
  return hash.digest('hex').slice(0, 12)
}

export function machine() {
  const [cpu] = cpus()
  const quiet = (command: string, args: string[]) => {
    try {
      return execFileSync(command, args, { encoding: 'utf8' }).trim()
    } catch {
      return undefined
    }
  }
  return {
    cpu: cpu?.model,
    threads: cpus().length,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    kernel: quiet('uname', ['-r']),
    uptime: quiet('uptime', []),
    // Another suite on the machine is the usual reason numbers are noisy;
    // this run's own runner and worker are not counted.
    otherVitestProcesses: (
      quiet('pgrep', ['-f', 'node_modules/.pnpm/vitest@']) ?? ''
    )
      .split('\n')
      .filter(
        (pid) =>
          pid !== '' &&
          Number(pid) !== process.pid &&
          Number(pid) !== process.ppid,
      ).length,
    sources: sources(),
  }
}

export type Options = {
  /** Measured rounds of time, after one warm-up round. */
  readonly rounds: number
  /** Measured rounds through the counting proxy, after one warm-up round. */
  readonly countRounds: number
  readonly idleSeconds: number
  /** Multiplies the runs of every batch. */
  readonly scale: number
  /** Only the specs whose id is listed, when given. */
  readonly only?: readonly string[]
  /** Caps every spec's time, for a quick look. */
  readonly maxTimeoutMs?: number
}

function number(name: string, fallback: number) {
  const value = process.env[name]
  return value === undefined ? fallback : Number(value)
}

export function options(defaults: { readonly scale?: number } = {}): Options {
  const only = process.env.BENCH_ONLY?.split(',').filter(Boolean)
  return {
    scale: number('BENCH_SCALE', defaults.scale ?? 1),
    rounds: number('BENCH_ROUNDS', 5),
    countRounds: number('BENCH_COUNT_ROUNDS', 2),
    idleSeconds: number('BENCH_IDLE_SECONDS', 35),
    ...(only ? { only } : {}),
    ...(process.env.BENCH_MAX_TIMEOUT_MS
      ? { maxTimeoutMs: number('BENCH_MAX_TIMEOUT_MS', Infinity) }
      : {}),
  }
}

function proxied(target: Target, port: number): Target {
  return target.store === 'memory' ? target : { ...target, via: port }
}

function endpoint(target: Exclude<Target, { store: 'memory' }>) {
  const url = new URL(target.url)
  return { host: url.hostname, port: Number(url.port) }
}

/**
 * Runs every spec against one store: timed directly, then counted through the
 * proxy when the store is a server.
 */
export async function measure(
  store: string,
  target: Target,
  { rounds, countRounds, idleSeconds, scale, only, maxTimeoutMs }: Options,
): Promise<Report> {
  const results = specs(scale)
    .filter((spec) => !only || only.includes(spec.id))
    .map((spec) =>
      maxTimeoutMs === undefined
        ? spec
        : { ...spec, timeoutMs: Math.min(spec.timeoutMs, maxTimeoutMs) },
    )
    .map((spec) => ({
      spec,
      timed: [] as Sample[],
      counted: [] as Sample[],
      failures: { timed: undefined, counted: undefined } as Record<
        'timed' | 'counted',
        Unfinished | undefined
      >,
    }))
  let idled: Idle | undefined
  const loadBefore = loadavg()
  await mkdir(directory(), { recursive: true })

  async function pass(
    engine: Engine,
    measured: number,
    into: 'timed' | 'counted',
    take?: () => Counts,
  ) {
    // Round 0 warms up: connections, prepared statements, scripts, the JIT.
    for (let round = 0; round <= measured; round++) {
      for (const result of results) {
        const { spec } = result
        if (round === 0 && !spec.warmup) continue
        if (round > (spec.rounds ?? measured)) continue
        // What did not finish once is not waited for again.
        if (result.failures[into] !== undefined) continue
        // What did not finish in time is counted once, for a while.
        const late = into === 'counted' && result.failures.timed
        if (late && round === 0) continue
        const timeoutMs = late
          ? Math.min(spec.timeoutMs, COUNT_BUDGET_MS)
          : spec.timeoutMs
        try {
          await engine.reset()
          const taken = await sample(engine, { ...spec, timeoutMs }, take)
          if (round > 0) result[into].push(taken)
        } catch (error) {
          result.failures[into] =
            error instanceof Stuck
              ? error.unfinished
              : {
                  message: String(error),
                  afterMs: Number.NaN,
                  handled: calls.count,
                  total: Number.NaN,
                }
          progress(`[${store}] ${spec.id}: FAILED ${String(error)}`)
          if (!(error instanceof Stuck)) console.log(error)
        }
        progress(
          `[${store}] ${into} round ${round}/${measured} ${spec.id} done`,
        )
      }
    }
  }

  const direct = await connect(target)
  try {
    await pass(direct, rounds, 'timed')
    if (target.store === 'memory' && idleSeconds > 0) {
      idled = await idle(direct, idleSeconds)
    }
  } finally {
    await direct.dispose()
  }

  if (target.store !== 'memory' && countRounds > 0) {
    const proxy = await countingProxy(
      target.store === 'postgres' ? 'postgres' : 'redis',
      endpoint(target),
    )
    const counted = await connect(proxied(target, proxy.port))
    try {
      await pass(counted, countRounds, 'counted', proxy.take)
      if (idleSeconds > 0) {
        idled = await idle(counted, idleSeconds, proxy.take)
      }
    } finally {
      await counted.dispose()
      await proxy.close()
    }
  }

  return {
    store,
    machine: machine(),
    settings: { rounds, countRounds, idleSeconds },
    loadBefore,
    loadAfter: loadavg(),
    specs: results,
    ...(idled ? { idle: idled } : {}),
  }
}

function quantiles(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = sorted.length / 2
  const median =
    sorted.length % 2 === 1
      ? sorted[Math.floor(middle)]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2
  return { median, min: sorted[0]!, max: sorted.at(-1)! }
}

const fixed = (value: number, digits = 1) =>
  value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })

function timing(values: readonly number[]) {
  if (values.length === 0) return 'n/a'
  const { median, min, max } = quantiles(values)
  return `${fixed(median)} (${fixed(min)}–${fixed(max)})`
}

/** The median of a count over the counted samples, per run of the batch. */
function perRun(
  samples: readonly Sample[],
  phase: 'started' | 'worked',
  runs: number,
  pick: (counts: Counts) => number,
) {
  const values = samples.flatMap((taken) =>
    taken[phase] ? [pick(taken[phase]) / runs] : [],
  )
  return values.length === 0 ? 'n/a' : fixed(quantiles(values).median)
}

/** The report as Markdown tables, one row for each spec. */
export function render(report: Report): string {
  const lines: string[] = []
  const { machine: host, settings } = report
  const postgres = report.store === 'postgres'
  const counted = report.specs.some(({ counted }) => counted.length > 0)

  lines.push(
    `## ${report.store}`,
    '',
    `${host.cpu}, ${host.threads} threads, Node ${host.node}, ${host.platform} ${host.kernel}.`,
    `Sources: ${host.sources} (sha256 of src).`,
    `Rounds: ${settings.rounds} timed after 1 warm-up${counted ? `, ${settings.countRounds} counted through the proxy after 1 warm-up` : ''}.`,
    `Load average before ${report.loadBefore.map((value) => fixed(value, 2)).join(' ')}, after ${report.loadAfter.map((value) => fixed(value, 2)).join(' ')}; other vitest processes at the end: ${host.otherVitestProcesses}.`,
    '',
    'Times are milliseconds for the whole batch: median (min–max).',
    '',
  )

  const header = [
    'workload',
    'ms',
    'runs/s',
    'CPU ms/run',
    ...(counted
      ? postgres
        ? ['stmts/run', 'round trips/run', 'tx/run', 'rows/run', 'kB in/run']
        : ['cmds/run', 'writes/run', 'kB out/run', 'kB in/run']
      : []),
  ]
  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`| ${header.map(() => '---').join(' | ')} |`)

  for (const { spec, timed, counted: counts, failures } of report.specs) {
    const phase = spec.workers ? 'worked' : 'started'
    const values = timed.map((taken) =>
      spec.workers ? (taken.workMs ?? Number.NaN) : taken.startMs,
    )
    const failure = failures.timed
    const count = (pick: (counts: Counts) => number) =>
      perRun(counts, phase, spec.runs, pick)
    const cells = [
      spec.title,
      failure && values.length === 0
        ? `unfinished after ${fixed(failure.afterMs / 1_000, 0)} s`
        : timing(values),
      values.length === 0
        ? 'n/a'
        : fixed((spec.runs / quantiles(values).median) * 1_000),
      spec.workers && timed.length > 0
        ? fixed(
            quantiles(timed.map((taken) => taken.cpuMs ?? Number.NaN)).median /
              spec.runs,
            2,
          )
        : 'n/a',
      ...(counted
        ? postgres
          ? [
              count((c) => c.statements),
              count((c) => c.roundTrips),
              count((c) => c.transactions + c.autocommits),
              count((c) => c.rows),
              count((c) => c.bytesFromServer / 1_024),
            ]
          : [
              count((c) => c.roundTrips),
              count((c) => c.writes),
              count((c) => c.bytesToServer / 1_024),
              count((c) => c.bytesFromServer / 1_024),
            ]
        : []),
    ]
    lines.push(`| ${cells.join(' | ')} |`)
  }

  const failed = report.specs.flatMap(({ spec, failures }) =>
    (['timed', 'counted'] as const).flatMap((into) => {
      const failure = failures[into]
      return failure ? [`- ${spec.id}, ${into}: ${failure.message}`] : []
    }),
  )
  if (failed.length > 0) lines.push('', 'Did not finish:', ...failed)

  const reported = report.specs.flatMap(
    ({ spec, timed, counted, failures }) => {
      const errors = [
        ...timed,
        ...counted,
        ...[failures.timed, failures.counted].flatMap((failure) =>
          failure ? [failure] : [],
        ),
      ].flatMap((taken) => taken.errors ?? [])
      if (errors.length === 0) return []
      const kinds = new Map<string, number>()
      for (const error of errors) {
        const kind = error.slice(0, 160)
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
      }
      return [
        `- ${spec.id}: ${errors.length} over all samples`,
        ...[...kinds]
          .toSorted((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([kind, count]) => `  - ${count}× ${kind}`),
      ]
    },
  )
  if (reported.length > 0) {
    lines.push(
      '',
      'Errors the workers reported and went on from (the runs completed):',
      ...reported,
    )
  }

  lines.push('', ...scaling(report))

  const taken = report.idle
  if (taken) {
    const rate = (value: number | undefined) =>
      value === undefined ? 'n/a' : fixed(value / taken.seconds, 2)
    const counts = taken.counts
    lines.push(
      '',
      'Idle: a coordinator and an execution worker, concurrency 8 each, nothing to do.',
      '',
      `| seconds | CPU ms/s | ${postgres ? 'stmts/s | round trips/s | tx/s' : 'cmds/s | writes/s'} |`,
      `| --- | --- | ${postgres ? '--- | --- | ---' : '--- | ---'} |`,
      `| ${fixed(taken.seconds)} | ${rate(taken.cpuMs)} | ${
        postgres
          ? `${rate(counts?.statements)} | ${rate(counts?.roundTrips)} | ${rate(counts && counts.transactions + counts.autocommits)}`
          : `${rate(counts?.roundTrips)} | ${rate(counts?.writes)}`
      } |`,
    )
  }

  return lines.join('\n')
}

/**
 * How the cost of a map grows with its items: everything per item, so that a
 * constant cost is a flat column. A map that did not finish is shown by what
 * it had done when it was given up.
 */
function scaling(report: Report): string[] {
  const postgres = report.store === 'postgres'
  const maps = report.specs.filter(({ spec }) => spec.workload === 'map')
  if (maps.length === 0) return []
  const counted = maps.some(({ counted }) => counted.length > 0)
  const lines = [
    counted
      ? `Maps, per item: ${postgres ? 'statements and rows' : 'commands'} from the counted rounds, time from the timed ones.`
      : 'Maps, per item: time from the timed rounds; nothing crosses a wire to count.',
    '',
    `| items | ms/item | ${postgres ? 'stmts/item | rows/item' : 'cmds/item'} | kB in/item | note |`,
    `| --- | --- | --- | ${postgres ? '--- | ' : ''}--- | --- |`,
  ]
  for (const { spec, timed, counted, failures } of maps) {
    const items = spec.input.n
    const times = timed.map((taken) => taken.workMs ?? Number.NaN)
    const late = failures.timed
    const worked = counted.flatMap((taken) =>
      taken.worked ? [taken.worked] : [],
    )
    const partial = failures.counted
    // Per handled item when the map did not finish.
    const per = (pick: (counts: Counts) => number) => {
      if (worked.length > 0) {
        return fixed(quantiles(worked.map(pick)).median / items, 1)
      }
      if (partial?.worked && partial.handled > 0) {
        return `${fixed(pick(partial.worked) / partial.handled, 1)}*`
      }
      return 'n/a'
    }
    const ms =
      times.length > 0
        ? fixed(quantiles(times).median / items, 2)
        : late && late.handled > 0
          ? `${fixed(late.afterMs / late.handled, 2)}*`
          : 'n/a'
    const notes = [
      ...(late
        ? [
            `${late.handled}/${late.total} items in ${fixed(late.afterMs / 1_000, 0)} s`,
          ]
        : []),
      ...(partial && worked.length === 0
        ? [
            `counted: ${partial.handled} items in ${fixed(partial.afterMs / 1_000, 0)} s`,
          ]
        : []),
    ]
    lines.push(
      `| ${items.toLocaleString('en-US')} | ${ms} | ${per((c) =>
        postgres ? c.statements : c.roundTrips,
      )} | ${postgres ? `${per((c) => c.rows)} | ` : ''}${per(
        (c) => c.bytesFromServer / 1_024,
      )} | ${notes.join('; ')} |`,
    )
  }
  if (lines.some((line) => line.includes('*'))) {
    lines.push(
      '',
      '\\* unfinished: per item handled before the sample was given up.',
    )
  }
  return lines
}

/** Prints the report and writes it, with every sample, where it is kept. */
export async function publish(report: Report) {
  const into = directory()
  await mkdir(into, { recursive: true })
  const rendered = render(report)
  await writeFile(
    resolve(into, `${report.store}.json`),
    JSON.stringify(report, null, 2),
  )
  await writeFile(resolve(into, `${report.store}.md`), `${rendered}\n`)
  console.log(`\n${rendered}\n\nWritten to ${into}/${report.store}.*`)
}
