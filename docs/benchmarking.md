# Benchmarking

Neemata's benchmark system detects runtime performance regressions without comparing
unrelated CI machines.

## Suites

- `runtime` contains deterministic in-memory benchmarks for workflow storage
  operations.
- `integration` measures the service-backed Postgres workflow runtime and Redis and
  Valkey pubsub. It runs on pull requests but remains informational because services
  add noise.

Run the deterministic runtime benchmarks directly through Vitest with:

```sh
pnpm bench
```

The benchmark command runs once, does not build packages, and does not write a report.
Run `pnpm build` separately when package artifacts are absent or stale.

Local benchmark commands print results, run once, and exit without writing report files.
CI and other jobs opt into normalized JSON persistence with `--output`; repository-local
outputs conventionally belong under the ignored `benchmark-results/` directory.
Paired local comparisons likewise use temporary reports unless an output directory is
requested explicitly.

Benchmark files run sequentially in isolated fork processes. This prevents heap and JIT
state from one benchmark file from affecting another while keeping CPU contention from
parallel benchmark workers out of the measurements.

```sh
node scripts/benchmarks/run.js runtime --output benchmark-results/runtime.json
```

## Neem RAM and CPU

Build the workspace, then run the process benchmark:

```sh
vp env exec pnpm build
vp env exec node scripts/benchmarks/neem-memory.js \
  --output benchmark-results/neem-memory.json
```

It measures production builds, `neem start`, the generated standalone `start.js`,
and `neem dev`. Runtime cases use 1 and 8 real HTTP workers with normal logging,
10,000 warmup requests, and 50,000 measured requests at concurrency 16. Production
builds run separately from server measurements. Each case runs in a fresh process.
The Node flags match Neem's executable (`--enable-source-maps --expose-gc`); the
harness does not force GC or tune heap limits, allocators, or compiler parallelism.
Compile caching is disabled for reproducibility.

For adjacent before/after pairs with alternating order, build both revisions under
the same Node version, then point to the baseline package:

```sh
vp env exec node scripts/benchmarks/neem-memory.js \
  --baseline-package /path/to/base/packages/neem \
  --rounds 3 --output benchmark-results/neem-paired.json
```

`--package` selects the candidate package. Both revisions use this checkout's
benchmark fixture. `--modes build,start,standalone,dev`, `--workers 1,8`, and
`--requests 50000 --warmup 10000` select the workload. Use longer warmup and load
phases to distinguish JIT/GC transients from sustained CPU regressions. Do not build, edit watched files, or run
other CPU-intensive jobs during a comparison.

To compare Node and Bun against the same package while keeping the load generator
on Node, use `--baseline-runtime node --runtime bun`. Runtime executables resolve
through the parent environment's `PATH`; `vp env exec` selects Node. Reports record
each child's runtime and version. For example:

```sh
vp env exec node scripts/benchmarks/neem-memory.js \
  --baseline-runtime node --runtime bun --workers 8 \
  --modes build,start,dev --warmup 50000 --requests 200000 \
  --output benchmark-results/neem-runtimes.json
```

Source-map behavior is runtime-specific: Bun 1.4.3 reports generated locations in
the tested error stacks for these external Rolldown maps, while Node remaps them.
Compare `NEEM_BENCH_MAPS=off` as a control before attributing all RSS differences
to the engines. Bun's `--smol` mode is not used because it trades performance for RAM.

RSS and CPU cover the whole Neem process, including worker threads and native
libraries. Never sum per-worker RSS: it counts the same process repeatedly. The
report includes idle RSS (median of ten samples after settling), loaded RSS,
process peak RSS, startup CPU/time, idle CPU over roughly one second, serving CPU
per request, and observed throughput. Build results include peak RSS, total CPU,
and elapsed time. The load generator runs in a separate process and is excluded
from Neem's CPU measurements, but it can limit throughput; use CPU per request as
well as throughput when checking regressions.

These are host-overhead measurements with a small application, not application
capacity limits or a long-running reload/leak test. Check representative workloads
before accepting a CPU-for-memory tradeoff. Native watch/build allocations and
source-map caches can dominate RSS even when the JavaScript heap is small.

To compare source-map policies with the same code and Node flags, run with
`NEEM_BENCH_MAPS=include`, `NEEM_BENCH_MAPS=exclude`, or `NEEM_BENCH_MAPS=off`.
Unset it to measure Neem's defaults. These control generated maps, not maps in
the installed CLI dependencies. Disabling maps is diagnostic: it also removes
mapped stack traces. The report records these environment settings.

### Measured source-map and import improvements

Local comparison against `e27c1f37`, using Node 24.16.0 on Linux x64,
Ryzen 9 7950X (32 logical CPUs), Rolldown 1.2.14, and the fixture above.
These are medians of three alternating pairs with 50,000 warmup and 100,000
measured requests. Both revisions enabled Node source maps, including standalone
launches. The candidate loads compiler commands lazily and omits embedded source
text from infrastructure maps while preserving mappings and application sources.

| Mode                  | Workers | Idle RSS, before → after (MiB) | Loaded RSS, before → after (MiB) |
| --------------------- | ------: | -----------------------------: | -------------------------------: |
| Production CLI        |       1 |                      248 → 208 |                        268 → 231 |
| Production CLI        |       8 |                      616 → 529 |                        770 → 689 |
| Standalone production |       1 |                      226 → 190 |                        249 → 214 |
| Standalone production |       8 |                      606 → 503 |                        752 → 661 |
| Development           |       1 |                      958 → 936 |                        978 → 958 |
| Development           |       8 |                  1,343 → 1,253 |                    1,496 → 1,419 |

Nine additional build pairs measured peak RSS of 788 → 778 MiB (no substantial
improvement), CPU of 1,299 → 1,178 ms, and elapsed time of 368 → 358 ms.
The median paired CPU change was -9.0%. Five longer production pairs at eight
workers (50,000 warmup / 200,000 measured requests) showed +0.8% serving CPU per
request and +0.4% throughput, within observed run variation; startup CPU fell 9.8%.
Three longer development pairs (200,000 warmup / 500,000 measured requests) showed
-1.2% serving CPU per request. Throughput's paired median was -2.3%, with individual
pairs ranging from -3.7% to +7.8%; this generator-limited fixture does not establish
a throughput gain or loss. No material sustained serving-CPU increase was measured.

Single-run source-policy diagnostics on the candidate at eight workers measured
597 MiB production / 1,336 MiB development idle RSS with all sources included,
versus 387 / 989 MiB with generated maps disabled. These are diagnostic samples,
not stable estimates. Maps remain enabled by default to retain mapped stack
traces. Native compiler/watch memory remains the main development cost; no
allocator, parallelism, heap-limit, or additional forced-GC tuning was adopted.

Raw local reports are under `benchmark-results/neem-final-paired.json`,
`neem-build-validation.json`, `neem-cpu-validation.json`, and
`neem-dev-cpu-validation.json`, plus `neem-maps-{include,off}.json`.
This directory is ignored; reproduce the comparison
with the commands above rather than treating these machine-specific numbers as
performance gates.

### Node versus Bun

On the same host and candidate package, three alternating pairs compared Node
24.16.0 with Bun 1.4.3 at eight workers, with 50,000 warmup and 200,000 measured
requests. The load generator stayed on Node and Bun's `--smol` mode was disabled.

| Mode                      | Node RSS (MiB) | Bun RSS (MiB) |  Paired CPU change |
| ------------------------- | -------------: | ------------: | -----------------: |
| Production idle / loaded  |      523 / 687 |     185 / 254 | -12.7% per request |
| Development idle / loaded |  1,239 / 1,404 |     868 / 938 | -12.2% per request |
| Build peak                |            774 |           703 |       -29.6% total |

Build elapsed time fell from 354 to 181 ms. Request throughput's paired median
was 1.3% lower in production and 3.7% lower in development; the separate generator
can limit throughput, so lower CPU is not proof of greater capacity. Short idle
CPU samples were higher on Bun: approximately 2.3 → 9.6 ms over one second in
production and 11.3 → 21.5 ms in development. These are startup-adjacent samples,
not a long-idle power-use measurement.

The default comparison includes different source-map behavior: Node remaps the
tested stacks, while Bun reports generated locations. With maps disabled in both,
a single control pair still measured production idle RSS of 390 → 188 MiB and
development of 1,006 → 758 MiB. Bun's savings therefore extend beyond map caches,
but this is a small host fixture, not evidence for every application workload.
Raw reports: `benchmark-results/neem-bun-paired.json` and `neem-bun-no-maps.json`.

## Integration benchmarks

Start the repository services, build, and opt into required service coverage:

```sh
docker compose up -d redis valkey postgres
pnpm build
NMTJS_REQUIRE_SERVICE_TESTS=1 \
REDIS_URL=redis://localhost:6379 \
VALKEY_URL=redis://localhost:6380 \
POSTGRES_URL=postgres://neemata:neemata@localhost:5432/neemata \
pnpm bench:integration
```

Without the service variables, service-backed cases skip cleanly. CI runs the complete integration suite for every pull request and retains the raw
report for 90 days.

## Pull request comparisons

The benchmark workflow checks out the pull request head and its base into separate
directories on one canonical `ubuntu-24.04` runner. Both run under the candidate's
exact pinned Node and pnpm versions so the runtime itself is identical; each checkout
still installs its own frozen lockfile. It builds outside the measured region and runs
three alternating rounds:

1. base, then head;
2. head, then base;
3. base, then head.

The comparison uses the median paired percentage change. A result only fails when the
slowdown exceeds its category threshold, appears in at least two of three rounds, and
is at least three median absolute deviations beyond the paired-round spread. A runtime
case whose relative margin of error exceeds its configured ceiling is `UNSTABLE`, not a
false regression failure.

Thresholds live in `benchmarks/thresholds.json`. Pull requests always use the file from
the base revision, so a candidate cannot loosen its own gate. Runtime regressions are
enforced; integration changes remain informational.

Benchmark source and configuration files are hashed into each report. When a pull
request changes a benchmark definition, that suite becomes `PENDING` until the changed
definition is present on the base branch. This prevents comparisons between different
workloads. When no benchmark-capable base exists yet, the CI summary still shows the
candidate median for every case in expandable suite sections.

For same-repository pull requests, the workflow also creates one benchmark report
comment and updates it on later runs, so results stay visible without accumulating
duplicate comments. Fork pull requests retain the job summary and artifact because
their workflow tokens are intentionally read-only.

When a pull request receives a new commit, GitHub cancels its older Test and Benchmark
workflow runs so only checks for the latest revision continue consuming runners.

## Evidence and maintenance

Every CI run uploads normalized reports, the full comparison JSON, and a concise job
summary. Correctness errors or malformed output fail immediately. Performance results
are never accepted by rewriting fixtures or increasing thresholds without review.

Keep timed functions narrow: construct fixed inputs and reusable infrastructure outside
the measured function, disable logging, avoid external network access, and batch work
that is too fast for the timer. New service or process benchmarks belong in the
integration suite unless repeated CI evidence shows they are stable enough to gate.
