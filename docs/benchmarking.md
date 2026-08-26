# Benchmarking

Neemata's benchmark system detects performance, type-complexity, and published-size
regressions without comparing unrelated CI machines.

## Suites

- `runtime` contains deterministic in-memory benchmarks for protocol codecs, dependency
  injection, the application API pipeline, and workflow storage operations.
- `types` generates representative linear, branch, parallel, and map workflow programs
  and records TypeScript type counts, instantiations, check time, total time, and memory.
- `sizes` records the raw bytes, per-file gzip bytes, and file count of each package's
  published file set after a build.
- `integration` measures loopback transports and service-backed Postgres, Redis, and
  Valkey paths. It is scheduled and informational because sockets and services add noise.

Run the fast suites against the currently built package artifacts with:

```sh
pnpm bench
```

The benchmark command does not build packages. Run `pnpm build` separately when
published artifacts are absent or stale.

Individual suites can be run with:

```sh
pnpm bench:runtime
pnpm bench:types
pnpm bench:sizes
```

Local benchmark commands print results, run once, and exit without writing report files.
CI and other jobs opt into normalized JSON persistence with `--output`; repository-local
outputs conventionally belong under the ignored `benchmark-results/` directory.
Paired local comparisons likewise use temporary reports unless an output directory is
requested explicitly.

```sh
node scripts/benchmarks/run.mjs runtime --output benchmark-results/runtime.json
```

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

Without the service variables, service-backed cases skip cleanly; loopback cases still
run. CI runs the complete integration suite every day and retains the raw report for 90
days.

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
the base revision, so a candidate cannot loosen its own gate. Runtime, deterministic
type counts, compiler timings, compiler memory, and package bytes have separate budgets.
Integration and package file-count changes remain informational.

Benchmark source and configuration files are hashed into each report. When a pull
request changes a benchmark definition, that suite becomes `PENDING` until the changed
definition is present on the base branch. This prevents comparisons between different
workloads. When no benchmark-capable base exists yet, the CI summary still shows the
candidate median for every case in expandable suite sections.

## Evidence and maintenance

Every CI run uploads normalized reports, the full comparison JSON, and a concise job
summary. Correctness errors or malformed output fail immediately. Performance results
are never accepted by rewriting fixtures or increasing thresholds without review.

Keep timed functions narrow: construct fixed inputs and reusable infrastructure outside
the measured function, disable logging, avoid external network access, and batch work
that is too fast for the timer. New service or process benchmarks belong in the
integration suite unless repeated CI evidence shows they are stable enough to gate.
