import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { Agent, get } from 'node:http'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({
  options: {
    package: { type: 'string', default: resolve(root, 'packages/neem') },
    'baseline-package': { type: 'string' },
    runtime: { type: 'string', default: process.execPath },
    'baseline-runtime': { type: 'string' },
    rounds: { type: 'string', default: '3' },
    workers: { type: 'string', default: '1,8' },
    modes: { type: 'string', default: 'build,start,standalone,dev' },
    requests: { type: 'string', default: '50000' },
    warmup: { type: 'string', default: '10000' },
    output: { type: 'string' },
  },
})
const positive = (value) => {
  const number = Number(value)
  assert(Number.isSafeInteger(number) && number > 0, `Invalid count: ${value}`)
  return number
}
const rounds = positive(values.rounds)
const workers = values.workers.split(',').map(positive)
const requests = positive(values.requests)
const warmupRequests = positive(values.warmup)
const modes = values.modes.split(',')
assert(
  modes.every((mode) => ['build', 'start', 'standalone', 'dev'].includes(mode)),
)
const variants = [
  ...(values['baseline-package'] || values['baseline-runtime']
    ? [
        {
          label: 'baseline',
          path: resolve(values['baseline-package'] ?? values.package),
          runtime: values['baseline-runtime'] ?? values.runtime,
        },
      ]
    : []),
  {
    label: 'candidate',
    path: resolve(values.package),
    runtime: values.runtime,
  },
]
const config = resolve(root, 'packages/neem/bench/memory/neem.config.ts')
const probe = resolve(root, 'scripts/benchmarks/neem-memory-probe.js')
const temporary = await mkdtemp(resolve(tmpdir(), 'neem-memory-'))
const results = []

async function launch(runtime, entry, args, count) {
  // Match the executable's shebang, including source maps and the existing
  // watcher's GC policy. The harness itself never forces a collection.
  const child = spawn(
    runtime,
    ['--enable-source-maps', '--expose-gc', '--import', probe, entry, ...args],
    {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NODE_DISABLE_COMPILE_CACHE: '1',
        NEEM_TEST_PROBE: '0',
        NEEM_SERVER_PORT: '0',
        NEEM_BENCH_WORKERS: String(count),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-16000)
  })
  child.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-16000)
  })
  const events = []
  child.on('message', (message) => events.push(message))
  const exit = once(child, 'exit')
  // Even failed builds/readiness checks must leave no daemon behind.
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
  const wait = async (predicate) => {
    const deadline = performance.now() + 90000
    while (performance.now() < deadline) {
      const index = events.findIndex(predicate)
      if (index !== -1) return events.splice(index, 1)[0]
      assert(child.exitCode === null && child.signalCode === null, output)
      await sleep(5)
    }
    throw new Error(`Timed out waiting for Neem\n${output}`)
  }
  return {
    wait,
    final: () => events.find((event) => event.source === 'neem:final'),
    async measure() {
      child.send('neem:measure')
      return wait((event) => event.source === 'neem:measure')
    },
    async stop(build = false) {
      try {
        if (!build && child.exitCode === null && child.signalCode === null)
          child.kill('SIGTERM')
        const [code, signal] = await exit
        assert.equal(code, 0, `Neem exited with ${code}/${signal}\n${output}`)
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
      }
    },
  }
}

async function load(urls, count) {
  const agent = new Agent({ keepAlive: true, maxSockets: 16 })
  let next = 0
  const start = performance.now()
  try {
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        for (;;) {
          const index = next++
          if (index >= count) return
          await new Promise((resolve, reject) => {
            const request = get(
              urls[index % urls.length],
              { agent },
              (response) => {
                let body = ''
                response.on('data', (chunk) => {
                  body += chunk
                })
                response.on('error', reject)
                response.on('end', () => {
                  try {
                    assert.equal(response.statusCode, 200)
                    assert.equal(body, 'neem-memory-benchmark')
                    resolve()
                  } catch (error) {
                    reject(error)
                  }
                })
              },
            )
            request.on('error', reject)
            request.setTimeout(10000, () =>
              request.destroy(new Error('HTTP timeout')),
            )
          })
        }
      }),
    )
    return performance.now() - start
  } finally {
    agent.destroy()
  }
}

const cpuMs = (sample) => (sample.cpu.user + sample.cpu.system) / 1000
const median = (numbers) => {
  const sorted = numbers.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

try {
  // Standalone output resolves its native proxy peer from the application.
  for (const variant of variants) {
    const directory = resolve(temporary, variant.label)
    await mkdir(directory, { recursive: true })
    await symlink(
      resolve(variant.path, 'node_modules'),
      resolve(directory, 'node_modules'),
      'junction',
    )
  }
  for (let round = 0; round < rounds; round++) {
    if (
      modes.includes('build') ||
      (round === 0 && modes.some((mode) => mode !== 'dev'))
    ) {
      for (const variant of round % 2 ? variants.toReversed() : variants) {
        const started = performance.now()
        const build = await launch(
          variant.runtime,
          resolve(variant.path, 'bin/neem.js'),
          [
            'build',
            '--config',
            config,
            '--out-dir',
            resolve(temporary, variant.label, 'build'),
          ],
          1,
        )
        await build.stop(true)
        const sample = build.final()
        assert(sample, 'Build exited without resource measurements')
        variant.version = sample.runtimeVersion
        if (modes.includes('build')) {
          const result = {
            round: round + 1,
            variant: variant.label,
            mode: 'build',
            durationMs: performance.now() - started,
            cpuMs: cpuMs(sample),
            peakRssMiB: sample.maxRss / 2 ** 20,
          }
          results.push(result)
          console.log(JSON.stringify(result))
        }
      }
    }
    for (const mode of modes.filter((mode) => mode !== 'build')) {
      for (const count of workers) {
        // Adjacent pairs, reversed each round, reduce drift from machine load.
        for (const variant of round % 2 ? variants.toReversed() : variants) {
          const outDir = resolve(
            temporary,
            variant.label,
            mode === 'dev' ? 'dev' : 'build',
          )
          const started = performance.now()
          const neem = await launch(
            variant.runtime,
            mode === 'standalone'
              ? resolve(outDir, 'start.js')
              : resolve(variant.path, 'bin/neem.js'),
            mode === 'standalone'
              ? []
              : mode === 'start'
                ? ['start', '--out-dir', outDir]
                : [
                    'dev',
                    '--no-cache',
                    '--config',
                    config,
                    '--out-dir',
                    outDir,
                  ],
            count,
          )
          try {
            const ready = await neem.wait(
              (event) => event.event === 'benchmark:ready',
            )
            const startupMs = performance.now() - started
            const startup = await neem.measure()
            variant.version = startup.runtimeVersion
            // Use real workers and normal logging. Do not force GC or change V8
            // heap limits: those can buy RAM by spending application CPU.
            await sleep(2000)
            const idle = []
            const beforeIdle = await neem.measure()
            for (let index = 0; index < 10; index++) {
              await sleep(100)
              idle.push(await neem.measure())
            }
            const urls = ready.health.runtimes.flatMap((runtime) =>
              runtime.threads.flatMap((thread) =>
                thread.upstreams.map((upstream) => upstream.url),
              ),
            )
            assert.equal(urls.length, count)
            await load(urls, warmupRequests)
            const before = await neem.measure()
            const loadMs = await load(urls, requests)
            const after = await neem.measure()
            const result = {
              round: round + 1,
              variant: variant.label,
              mode,
              workers: count,
              startupMs,
              startupCpuMs: cpuMs(startup),
              idleRssMiB: median(idle.map((sample) => sample.rss)) / 2 ** 20,
              idleCpuMs: cpuMs(idle.at(-1)) - cpuMs(beforeIdle),
              loadedRssMiB: after.rss / 2 ** 20,
              peakRssMiB: after.maxRss / 2 ** 20,
              requestsPerSecond: requests / (loadMs / 1000),
              cpuUsPerRequest:
                ((cpuMs(after) - cpuMs(before)) * 1000) / requests,
            }
            results.push(result)
            console.log(JSON.stringify(result))
          } finally {
            await neem.stop()
          }
        }
      }
    }
  }
  if (values.output) {
    const file = resolve(values.output)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpu: cpus()[0]?.model,
          parallelism: availableParallelism(),
          variants,
          requests,
          warmupRequests,
          concurrency: 16,
          environment: Object.fromEntries(
            Object.entries(process.env).filter(([key]) =>
              /^(NODE_OPTIONS|NEEM_BENCH_MAPS|RAYON_|MIMALLOC_|MALLOC_)/.test(
                key,
              ),
            ),
          ),
          results,
        },
        null,
        2,
      ) + '\n',
    )
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
