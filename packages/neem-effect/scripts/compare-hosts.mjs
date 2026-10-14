import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

// Measures process startup and graceful shutdown with the same idle application.
// This is host overhead, not an application-throughput benchmark.
const runs = Number(process.argv[2] ?? 5)
const workers = Number(process.argv[3] ?? 4)
if (![runs, workers].every((n) => Number.isInteger(n) && n > 0 && n <= 100)) {
  throw new Error(
    'Usage: node compare-hosts.mjs [runs:1..100] [workers:1..100]',
  )
}
const packages = resolve(import.meta.dirname, '../..')
const tempRoot = resolve(packages, 'neem/.benchmark')
await mkdir(tempRoot, { recursive: true })
const fixture = await mkdtemp(resolve(tempRoot, 'hosts-'))
const samples = { neem: [], 'neem-effect': [] }

try {
  await writeFile(
    resolve(fixture, 'neem.config.ts'),
    `
    import { defineConfig } from '@nmtjs/neem'
    export default defineConfig({ logger: { level: 'silent' }, runtimes: ['./app.runtime.ts'] })
  `,
  )
  await writeFile(
    resolve(fixture, 'app.runtime.ts'),
    `import { defineRuntime } from '@nmtjs/neem'
    export default defineRuntime({ name: 'app', planner: './planner.ts', worker: { entry: './worker.ts' } })`,
  )
  await writeFile(
    resolve(fixture, 'planner.ts'),
    `
    import { defineRuntimePlanner } from '@nmtjs/neem'
    export default defineRuntimePlanner(() => ({ workers: Array.from({ length: ${workers} }, () => ({})) }))
  `,
  )
  await writeFile(
    resolve(fixture, 'worker.ts'),
    `
    import { defineRuntimeWorker } from '@nmtjs/neem'
    export default defineRuntimeWorker({ createRuntime: () => ({ start() {}, stop() {} }) })
  `,
  )
  const bins = {
    neem: resolve(packages, 'neem/bin/neem.js'),
    'neem-effect': resolve(packages, 'neem-effect/bin/neem-effect.js'),
  }
  for (const [name, bin] of Object.entries(bins)) {
    await build(bin, resolve(fixture, name))
  }
  // Discard one warm-up per host, then alternate ordering to limit order bias.
  for (let round = -1; round < runs; round++) {
    const names =
      round % 2 === 0 ? ['neem-effect', 'neem'] : ['neem', 'neem-effect']
    for (const name of names) {
      const sample = await measure(bins[name], resolve(fixture, name))
      if (round >= 0) samples[name].push(sample)
    }
  }
  const median = (values) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        runs,
        workers,
        metric:
          'CLI start to application-ready; SIGTERM to exit; process RSS at readiness',
        medians: Object.fromEntries(
          Object.entries(samples).map(([name, values]) => [
            name,
            {
              startMs: median(values.map((s) => s.startMs)),
              stopMs: median(values.map((s) => s.stopMs)),
              rssMiB:
                process.platform === 'linux'
                  ? median(values.map((s) => s.rssMiB))
                  : null,
            },
          ]),
        ),
        samples,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(fixture, { recursive: true, force: true })
}

async function build(bin, outDir) {
  const child = spawn(
    process.execPath,
    [
      bin,
      'build',
      '--config',
      resolve(fixture, 'neem.config.ts'),
      '--outDir',
      outDir,
    ],
    {
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  await waitExit(child, 60_000)
}

async function measure(bin, outDir) {
  const started = performance.now()
  const child = spawn(process.execPath, [bin, 'start', '--outDir', outDir], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NEEM_TEST_PROBE: '1',
      NEEM_SERVER_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const exited = waitExit(child, 30_000)
  // Observe early exit immediately, even while readiness is pending.
  void exited.catch(() => {})
  try {
    const ready = new Promise((resolveReady) =>
      child.on('message', (event) => {
        if (
          event?.source === 'neem:test-probe' &&
          event.event === 'runtime:ready'
        )
          resolveReady()
      }),
    )
    await Promise.race([
      ready,
      exited.then(() => {
        throw new Error('Exited before readiness')
      }),
    ])
    const startMs = performance.now() - started
    await sleep(50)
    const status =
      process.platform === 'linux'
        ? await readFile(`/proc/${child.pid}/status`, 'utf8')
        : ''
    const rssMiB = status
      ? Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) / 1024
      : null
    const stopping = performance.now()
    child.kill('SIGTERM')
    await exited
    return { startMs, stopMs: performance.now() - stopping, rssMiB }
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
    await exited.catch(() => {})
  }
}

function waitExit(child, timeoutMs) {
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output += chunk
  })
  child.stderr?.on('data', (chunk) => {
    output += chunk
  })
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolveExit()
      else reject(new Error(`Process exited ${code}/${signal}\n${output}`))
    })
  })
}
