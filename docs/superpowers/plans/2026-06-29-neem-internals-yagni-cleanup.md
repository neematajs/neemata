# Neem Internals YAGNI Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify `packages/neem/src/internal` by deleting internal-only over-modeling while preserving all current public features and APIs.

**Architecture:** Keep behavior stable, but collapse internal shapes that carry fake data, duplicated state, optional defensive fallbacks, or scalar-first models around grouped work. Prefer direct typed boundaries over generic wrappers; keep public `@nmtjs/neem` types compatible unless a change is purely additive and needed internally.

**Tech Stack:** TypeScript, Node worker threads, Rolldown, Vitest, oxlint.

---

## Constraints

- Do not create a branch unless explicitly asked.
- Do not change public API behavior or remove public features.
- Do not add tests that only assert old internal APIs no longer exist.
- When running tests, append `--reporter=agent`.
- When running typecheck, append `--pretty false`.
- When running oxlint, append `--format=agent`.

## File Map

- Modify `packages/neem/src/internal/build/graph.ts`: remove discriminated singleton `BuildGroup` wrappers; use array-first groups.
- Modify `packages/neem/src/internal/build/compiler.ts`: use one target-array compile/watch path, one metadata map, and array-first rebuild events.
- Modify `packages/neem/src/internal/services/watcher.ts`: classify array-first target changes.
- Modify `packages/neem/src/internal/build/declarations.ts`: make planner resolution the canonical declaration responsibility.
- Modify `packages/neem/src/internal/services/protocol.ts`: split service commands from wire requests and stop making success payloads optional where they are required.
- Modify `packages/neem/src/internal/services/client.ts`: attach request IDs inside the transport and accept command objects without fake IDs.
- Modify `packages/neem/src/cli.ts`: send ID-free service commands and consume start results directly.
- Modify `packages/neem/src/internal/services/runtime.ts`: store one required runtime service context; use shared snapshot loader.
- Modify `packages/neem/src/internal/standalone/entry.ts`: use shared snapshot loader.
- Modify `packages/neem/src/internal/manifest/snapshot.ts`: add shared `loadRuntimeSnapshot` helper.
- Modify `packages/neem/src/internal/host/controller.ts`: extract shared boot orchestration for start/reload.
- Modify `packages/neem/src/internal/host/runtime.ts`: merge host/thread failure handling.
- Modify `packages/neem/src/internal/schemas/runtime.ts`: export schema-narrowed internal upstream type.
- Modify `packages/neem/src/internal/host/proxy.ts`: remove transport cast by accepting narrowed upstreams internally.
- Update focused tests in `packages/neem/tests/unit/build-graph.spec.ts`, `packages/neem/tests/unit/compiler.spec.ts`, `packages/neem/tests/unit/services-client.spec.ts`, `packages/neem/tests/unit/runtime-topology.spec.ts`, and affected e2e tests that observe internal test-probe events.

## Task 1: Array-First Build Groups And Change Events

**Files:**
- Modify `packages/neem/src/internal/build/graph.ts`
- Modify `packages/neem/src/internal/build/compiler.ts`
- Modify `packages/neem/src/internal/services/watcher.ts`
- Test `packages/neem/tests/unit/build-graph.spec.ts`
- Test `packages/neem/tests/unit/compiler.spec.ts`

- [ ] **Step 1: Update build graph tests first**

In `packages/neem/tests/unit/build-graph.spec.ts`, update expectations around `graph.buildGroups` so groups have `key` and `targets`, without a `kind` discriminator:

```ts
expect(graph.buildGroups.map((group) => group.key)).toEqual([
  'runtime:infra',
  'config:logger',
  'runtime:api:worker',
  'runtime:api:host',
  'runtime:api:planner',
  'runtime:scheduler:host',
  'runtime:scheduler:planner',
  'plugin:000-scope-plugin-one',
])
expect(graph.buildGroups[0]?.targets.map((target) => target.kind)).toEqual([
  'start-entry',
  'worker-entry',
  'host-runner-entry',
])
expect(graph.buildGroups[1]?.targets.map((target) => target.key)).toEqual([
  'config:logger',
])
```

In `packages/neem/tests/unit/compiler.spec.ts`, update the infra watcher rebuild assertion to use array-first change data:

```ts
const change = onChange.mock.calls[0]?.[0]
expect(change.targets).toEqual([
  graph.startEntry,
  graph.workerEntry,
  graph.hostRunnerEntry,
])
expect(change.compiledTargets.map((target) => target.artifact.file)).toEqual([
  resolve(root, 'dist/runtime/start.js'),
  resolve(root, 'dist/runtime/worker-entry.js'),
  resolve(root, 'dist/runtime/runner-entry.js'),
])
```

- [ ] **Step 2: Run focused tests and confirm expected failures**

Run:

```bash
pnpm --filter @nmtjs/neem test:unit -- --reporter=agent packages/neem/tests/unit/build-graph.spec.ts packages/neem/tests/unit/compiler.spec.ts
```

Expected: failures mention missing `targets` shape or stale `kind`/`target` expectations.

- [ ] **Step 3: Simplify `BuildGroup`**

In `packages/neem/src/internal/build/graph.ts`, replace `BuildGroup` with:

```ts
export type BuildGroup = {
  key: string
  targets: readonly BuildTarget[]
}
```

Build groups in `createBuildGraph` should become:

```ts
const infraTargets = [startEntry, workerEntry, hostRunnerEntry] as const
const buildGroups: BuildGroup[] = [
  { key: 'runtime:infra', targets: infraTargets },
  ...targets.slice(infraTargets.length).map((target) => ({
    key: target.key,
    targets: [target],
  })),
]
```

- [ ] **Step 4: Collapse compiler compile/watch paths**

In `packages/neem/src/internal/build/compiler.ts`, change metadata and events to array-first:

```ts
type ArtifactInput = { target: BuildTarget; entry: string; input: string }

type ArtifactBuildMetadata = {
  entryFileNames: Map<string, string | undefined>
  watch: boolean
}

export type TargetChange = {
  targets: readonly BuildTarget[]
  compiledTargets: readonly CompiledTarget[]
  initial: boolean
}
```

Use one group compiler:

```ts
async function compileBuildGroup(
  group: BuildGroup,
): Promise<readonly CompiledTarget[]> {
  return compileTargets(group.targets)
}

async function compileTargets(
  targets: readonly BuildTarget[],
): Promise<readonly CompiledTarget[]> {
  const metadata: ArtifactBuildMetadata = {
    entryFileNames: new Map(),
    watch: false,
  }
  await mkdirTargetDirs(targets)
  const bundle =
    targets.length === 1
      ? await rolldown.build(createRolldownOptions(targets[0]!, metadata))
      : await rolldown.build(createGroupedRolldownOptions(targets, metadata))
  return createResolvedTargets(targets, bundle, metadata)
}
```

Keep `compileTarget` as a public internal adapter:

```ts
export async function compileTarget(
  target: BuildTarget,
): Promise<CompiledTarget> {
  const [compiled] = await compileTargets([target])
  if (!compiled) throw new Error(`Compiled target [${target.key}] is missing`)
  return compiled
}
```

Replace `watchBuildGroup`, `watchTarget`, and `watchTargetGroup` internals with one `watchTargets()` function that emits:

```ts
await handlers.onRebuild?.({
  targets,
  compiledTargets,
  initial: false,
})
```

Keep `watchTarget()` as an adapter that awaits `watchTargets([target])` and returns the first compiled target.

- [ ] **Step 5: Make metadata always key by `target.key`**

Update input creation:

```ts
function createArtifactInput(target: BuildTarget): ArtifactInput {
  const entry = toFilePath(target.artifact.entry)
  return { target, entry, input: entry }
}

function createArtifactInputs(
  targets: readonly BuildTarget[],
): ArtifactInput[] {
  return targets.map((target) => ({
    target,
    entry: toFilePath(target.artifact.entry),
    input: getArtifactInputName(target),
  }))
}
```

Update artifact resolution:

```ts
const metadataEntryFileName = metadata.entryFileNames.get(target.key)
const entryFileName = metadataEntryFileName ?? entryChunk?.fileName
```

Update metadata plugin:

```ts
metadata.entryFileNames.set(input.target.key, entryChunk?.fileName)
```

- [ ] **Step 6: Update watcher classification**

In `packages/neem/src/internal/services/watcher.ts`, make `classifyChange` use the first meaningful target from `change.targets`:

```ts
function classifyChange(change: TargetChange): WatcherManifestChangeInput {
  const target = change.targets[0]
  if (!target) return { type: 'plugin-changed' }

  switch (target.kind) {
    case 'runtime-worker':
    case 'runtime-planner':
      return { type: 'runtime-changed', runtimeName: getRuntimeName(target) }
    case 'runtime-host':
      return { type: 'runtime-host-changed', runtimeName: getRuntimeName(target) }
    case 'plugin-entry':
      return { type: 'plugin-changed' }
    case 'logger':
      return { type: 'logger-changed' }
    case 'start-entry':
    case 'worker-entry':
    case 'host-runner-entry':
      return { type: 'plugin-changed' }
  }
}

function getRuntimeName(target: BuildTarget): string {
  const owner = target.owner
  return owner.type === 'runtime' ? owner.name : 'unknown'
}
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm --filter @nmtjs/neem test:unit -- --reporter=agent packages/neem/tests/unit/build-graph.spec.ts packages/neem/tests/unit/compiler.spec.ts
```

Expected: PASS.

## Task 2: Declaration And Graph Boundary Cleanup

**Files:**
- Modify `packages/neem/src/internal/build/declarations.ts`
- Modify `packages/neem/src/internal/build/graph.ts`
- Test `packages/neem/tests/unit/build-graph.spec.ts`
- Test `packages/neem/tests/e2e/declaration-errors.spec.ts`

- [ ] **Step 1: Add tests around planner ownership and invalid hostless runtimes**

In `packages/neem/tests/unit/build-graph.spec.ts`, keep graph-level assertions that planner entries are already resolved:

```ts
expect(api?.planner.artifact.entry).toBe('/workspace/app/api/neem.planner.ts')
```

In `packages/neem/tests/e2e/declaration-errors.spec.ts`, keep existing coverage for missing worker/custom host. Do not add tests for deleted graph branches.

- [ ] **Step 2: Delete dead graph branch and stop re-resolving planner**

In `packages/neem/src/internal/build/graph.ts`, replace planner entry resolution with the already resolved value:

```ts
const plannerEntry = options.runtime.planner
```

Delete this branch because `hostEntry` always defaults:

```ts
if (!workerEntry && !hostEntry) {
  throw new Error(
    `Runtime [${options.name}] must configure a worker or host entry`,
  )
}
```

Keep declaration validation in `declarations.ts`:

```ts
if (!declaration.worker && !declaration.host?.entry) {
  throw new Error(
    `Runtime declaration file [${file}] must provide a worker or a custom host entry`,
  )
}
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm --filter @nmtjs/neem test:e2e -- --reporter=agent packages/neem/tests/e2e/declaration-errors.spec.ts
pnpm --filter @nmtjs/neem test:unit -- --reporter=agent packages/neem/tests/unit/build-graph.spec.ts
```

Expected: PASS.

## Task 3: Service RPC Boundary And Startup Result Flow

**Files:**
- Modify `packages/neem/src/internal/services/protocol.ts`
- Modify `packages/neem/src/internal/services/client.ts`
- Modify `packages/neem/src/internal/services/watcher.ts`
- Modify `packages/neem/src/internal/services/watcher-entry.ts`
- Modify `packages/neem/src/internal/services/runtime.ts`
- Modify `packages/neem/src/internal/services/runtime-entry.ts`
- Modify `packages/neem/src/cli.ts`
- Test `packages/neem/tests/unit/services-client.spec.ts`
- Update e2e tests that wait for `watcher:ready` or `runtime:ready` only if probe emission changes.

**Important boundary decision:** keep request/response correlation IDs on the worker wire protocol. Abort and shutdown can send `stop` while `start` is still unresolved, so deleting IDs or forcing single-flight requests would make cleanup worse. This task may hide fake caller-supplied `id: 0` only if it stays simple; if that type split gets noisy, drop the caller-command refactor and only implement the ready event/result cleanup in Step 5.

- [ ] **Step 1: Update service client tests first**

In `packages/neem/tests/unit/services-client.spec.ts`, add/adjust coverage so requests do not contain caller-supplied IDs:

```ts
const client = new WorkerServiceClient<{ type: 'event' }, { type: 'start' }, { ok: true }>({
  entry,
  serviceName: 'fixture',
})

const resultPromise = client.request({ type: 'start' })

const message = await waitForWorkerMessage()
expect(message).toMatchObject({ id: 1, type: 'start' })
```

Also cover stop without fake ID:

```ts
await client.stop({ type: 'stop' })
```

- [ ] **Step 2: Keep wire IDs; optionally define explicit caller command types**

Do not use a generic `WithoutId<T>` helper here. If removing fake caller IDs stays low-churn, define explicit command types in `packages/neem/src/internal/services/protocol.ts`:

```ts
export type WatcherCommand =
  | Omit<WatcherStartRequest, 'id'>
  | Omit<WatcherStopRequest, 'id'>

export type RuntimeCommand =
  | Omit<RuntimeStartRequest, 'id'>
  | Omit<RuntimeReloadRequest, 'id'>
  | Omit<RuntimeReloadRuntimeRequest, 'id'>
  | Omit<RuntimeStopRequest, 'id'>
```

Keep `WatcherRequest`, `RuntimeRequest`, `RuntimeResponse`, and `WatcherResponse` with `id` for the worker entry files. If the explicit command types create churn across tests/call sites, revert this step and leave fake `id: 0` in place for now.

- [ ] **Step 3: Make client attach IDs internally**

Only do this if Step 2 stayed simple. In `packages/neem/src/internal/services/client.ts`, change class generic and request signatures:

```ts
export class WorkerServiceClient<
  TEvent,
  TCommand extends { type: string } = { type: string },
  TResult = unknown,
> {
  request<T extends TCommand, TData = TResult>(
    request: T,
    options: { timeoutMs?: number } = {},
  ): Promise<TData | undefined> {
    const id = this.nextId++
    const message = { ...request, id }
    // existing timeout/pending/postMessage flow
    this.worker.postMessage(message)
    return future.promise as Promise<TData | undefined>
  }

  async stop(
    request: Extract<TCommand, { type: 'stop' }> = { type: 'stop' } as Extract<
      TCommand,
      { type: 'stop' }
    >,
  ): Promise<void> {
    // existing stop flow calls this.request(request, ...)
  }
}
```

If this step expands beyond service client and CLI call-site typing, stop and skip to Step 5. The value is removing fake caller IDs, not redesigning the RPC layer.

- [ ] **Step 4: Update typed clients and call sites**

Only do this if Steps 2-3 stayed simple. In `packages/neem/src/cli.ts`, define clients with command types:

```ts
type WatcherClient = WorkerServiceClient<
  WatcherEvent,
  WatcherCommand,
  WatcherResult
>
type RuntimeClient = WorkerServiceClient<
  RuntimeEvent,
  RuntimeCommand,
  RuntimeResult
>
```

Update all calls from:

```ts
await runtime.request({
  id: 0,
  type: 'reload-runtime',
  runtimeName,
  manifestFile: this.manifestFile,
})
```

to:

```ts
await runtime.request({
  type: 'reload-runtime',
  runtimeName,
  manifestFile: this.manifestFile,
})
```

If Steps 2-4 are skipped, keep these calls unchanged and continue with Step 5.

- [ ] **Step 5: Use start results directly and keep probe events at CLI edge**

In `WatcherService.start`, remove the internal success event:

```ts
// remove: await this.emit({ type: 'ready', ...manifest })
return {
  manifestFile: manifest.manifestFile,
  manifestRevision: manifest.manifestRevision,
  manifestHash: manifest.manifestHash,
  configSignalFiles: this.getConfigSignalFiles(graph),
}
```

Extend `WatcherResult` to include the manifest identity fields directly:

```ts
export type WatcherResult = WatcherManifestIdentity & {
  configSignalFiles?: readonly string[]
}
```

In `cli.ts`, after watcher start result:

```ts
if (result) {
  this.options.probe?.emit('watcher:ready', normalizeEvent({ type: 'ready', ...result }))
  this.acceptManifest({ type: 'ready', ...result }, { resetRevision: true })
  if (result.configSignalFiles) {
    await this.startConfigSignalWatcher(result.configSignalFiles)
  }
  await this.restartRuntime()
}
```

In `RuntimeService.start`, remove the internal ready event:

```ts
// remove: options.emit({ type: 'ready', health })
return health
```

In `cli.ts`, after runtime start result:

```ts
const result = await runtime.request<RuntimeCommand, RuntimeResult>({
  type: 'start',
  mode: 'development',
  outDir: this.options.outDir,
  manifestFile: this.manifestFile,
  runtimes: this.options.runtimes,
})
if (result?.health) {
  this.options.probe?.emit(
    'runtime:ready',
    normalizeEvent({ type: 'ready', health: result.health }),
  )
}
```

Keep asynchronous `error` and `stopped` events.

- [ ] **Step 6: Run service and reload tests**

Run:

```bash
pnpm --filter @nmtjs/neem test:unit -- --reporter=agent packages/neem/tests/unit/services-client.spec.ts
pnpm --filter @nmtjs/neem test:e2e -- --reporter=agent packages/neem/tests/e2e/services.spec.ts packages/neem/tests/e2e/watcher-reload.spec.ts
```

Expected: PASS.

## Task 4: Runtime Snapshot Context

**Files:**
- Modify `packages/neem/src/internal/manifest/snapshot.ts`
- Modify `packages/neem/src/internal/services/runtime.ts`
- Modify `packages/neem/src/internal/standalone/entry.ts`
- Test `packages/neem/tests/unit/runtime-topology.spec.ts`
- Test `packages/neem/tests/e2e/services.spec.ts`

- [ ] **Step 1: Add shared snapshot loader**

In `packages/neem/src/internal/manifest/snapshot.ts`, add imports:

```ts
import {
  assertManifestFilesExist,
  readManifest,
  selectManifestRuntimes,
} from './manifest.ts'
import { resolveManifestLogger } from '../logger.ts'
```

Add helper:

```ts
export async function loadRuntimeSnapshot(options: {
  mode: NeemMode
  outDir: string
  env?: NodeJS.ProcessEnv
  manifestFile: string
  runtimes?: readonly string[]
  logger?: Logger
}): Promise<RuntimeSnapshot> {
  const manifest = selectManifestRuntimes(
    await readManifest(options.manifestFile),
    options.runtimes,
  )
  await assertManifestFilesExist(options.outDir, manifest)
  const logger =
    options.logger ??
    (await resolveManifestLogger(manifest.config.logger, {
      mode: options.mode,
      outDir: options.outDir,
    }))

  return createRuntimeSnapshot({
    mode: options.mode,
    outDir: options.outDir,
    env: options.env,
    manifest,
    manifestFile: options.manifestFile,
    logger,
  })
}
```

- [ ] **Step 2: Replace optional runtime service fields with one context**

In `packages/neem/src/internal/services/runtime.ts`, replace optional fields:

```ts
private context:
  | {
      mode: NeemMode
      outDir: string
      env?: NodeJS.ProcessEnv
      runtimes?: readonly string[]
    }
  | undefined
```

In `start`:

```ts
this.context = {
  mode: options.mode,
  outDir: options.outDir,
  env: options.env,
  runtimes: options.runtimes,
}
const snapshot = await this.loadSnapshot(options.manifestFile)
```

In `loadSnapshot`:

```ts
private async loadSnapshot(manifestFile: string) {
  const context = this.context
  if (!context) throw new Error('Neem runtime service is not started')
  return loadRuntimeSnapshot({ ...context, manifestFile })
}
```

- [ ] **Step 3: Use loader in standalone entry**

In `packages/neem/src/internal/standalone/entry.ts`, replace the manifest read/assert/logger block with:

```ts
const snapshot = await loadRuntimeSnapshot({
  mode: 'production',
  outDir,
  env: options.env,
  manifestFile,
  runtimes: options.runtimes,
})
```

Pass `snapshot` directly into `HostController`.

- [ ] **Step 4: Run runtime tests**

Run:

```bash
pnpm --filter @nmtjs/neem test:unit -- --reporter=agent packages/neem/tests/unit/runtime-topology.spec.ts
pnpm --filter @nmtjs/neem test:e2e -- --reporter=agent packages/neem/tests/e2e/services.spec.ts
```

Expected: PASS.

## Task 5: Host Lifecycle Duplication

**Files:**
- Modify `packages/neem/src/internal/host/controller.ts`
- Modify `packages/neem/src/internal/host/runtime.ts`
- Test `packages/neem/tests/e2e/recovery-health-proxy.spec.ts`
- Test `packages/neem/tests/e2e/services.spec.ts`

- [ ] **Step 1: Extract shared HostController boot path**

In `packages/neem/src/internal/host/controller.ts`, add:

```ts
private async bootSubsystems(options: {
  readyHook: 'server:ready' | 'server:reload'
}): Promise<void> {
  await this.startPlugins()
  await this.syncHealthProbe()
  await this.callServerHook('server:start')
  await this.startRuntimes()
  await this.startProxy()
  this.markState('running')
  await this.callServerHook(options.readyHook)
}
```

Update `start()` body to call:

```ts
await this.bootSubsystems({ readyHook: 'server:ready' })
```

Update `reload()` body after `replaceSnapshot(snapshot)` to call:

```ts
await this.bootSubsystems({ readyHook: 'server:reload' })
```

Keep different log messages and failure messages in `start()` and `reload()`.

- [ ] **Step 2: Merge runtime host/thread failure handling**

In `packages/neem/src/internal/host/runtime.ts`, replace `handleThreadFailure` and `handleHostFailure` shared body with:

```ts
private async handleRuntimeFailure(
  error: Error,
  source: string,
): Promise<void> {
  this.logger?.warn({ err: error }, source)
  await this.callRuntimeFailHook(error)

  if (this.recoveryPromise) return

  const policy = createRecoveryPolicy(
    this.options.snapshot.mode,
    this.options.recovery,
  )
  if (policy.attempts === 0) {
    await this.options.onFailure?.(error, this)
    return
  }

  this.recoveryPromise = this.recover(error).finally(() => {
    this.recoveryPromise = undefined
  })
  await this.recoveryPromise
}
```

Then keep small source-specific wrappers:

```ts
private handleThreadFailure(error: Error, thread: ThreadController): Promise<void> {
  return this.handleRuntimeFailure(
    error,
    `Neem runtime worker ${thread.name} failed`,
  )
}

private handleHostFailure(error: Error): Promise<void> {
  return this.handleRuntimeFailure(error, 'Neem runtime host failed')
}
```

- [ ] **Step 3: Run lifecycle tests**

Run:

```bash
pnpm --filter @nmtjs/neem test:e2e -- --reporter=agent packages/neem/tests/e2e/recovery-health-proxy.spec.ts packages/neem/tests/e2e/services.spec.ts
```

Expected: PASS.

## Task 6: Proxy Upstream Internal Type Boundary

**Files:**
- Modify `packages/neem/src/internal/schemas/runtime.ts`
- Modify `packages/neem/src/internal/host/proxy.ts`
- Optionally modify `packages/neem/src/internal/host/runtime.ts` only if type propagation requires it.
- Test `packages/neem/tests/unit/proxy.spec.ts`
- Test `packages/neem/tests/e2e/recovery-health-proxy.spec.ts`

- [ ] **Step 1: Export parsed upstream type**

In `packages/neem/src/internal/schemas/runtime.ts`, add:

```ts
export type ParsedRuntimeUpstream = {
  type: 'http' | 'http2' | 'ws'
  url: string
}
```

Update parse functions:

```ts
export function parseRuntimeUpstreams(
  upstreams: unknown,
): readonly ParsedRuntimeUpstream[] {
  return runtimeUpstreamsSchema.parse(upstreams) as readonly ParsedRuntimeUpstream[]
}

export function parseRuntimeStartResult(
  result: unknown,
): readonly ParsedRuntimeUpstream[] {
  const parsed = runtimeStartResultSchema.parse(result)
  if (parsed === undefined) return []
  if (Array.isArray(parsed)) return parsed as readonly ParsedRuntimeUpstream[]
  return (parsed.upstreams ?? []) as readonly ParsedRuntimeUpstream[]
}
```

Keep public `NeemRuntimeUpstream` unchanged.

- [ ] **Step 2: Remove proxy transport cast**

In `packages/neem/src/internal/host/proxy.ts`, import the internal type:

```ts
import type { ParsedRuntimeUpstream } from '../schemas/runtime.ts'
```

Change proxy conversion input:

```ts
export function toProxyUpstream(
  upstream: ParsedRuntimeUpstream,
): NeemProxyUpstream {
  const url = new URL(upstream.url)
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const port = url.port ? Number.parseInt(url.port, 10) : secure ? 443 : 80

  return {
    type: 'port',
    transport: upstream.type,
    secure,
    hostname: url.hostname,
    port,
  }
}
```

For `normalizeRuntimeUpstream`, either return `ParsedRuntimeUpstream` after validating known transport:

```ts
export function normalizeRuntimeUpstream(
  upstream: NeemRuntimeUpstream,
): ParsedRuntimeUpstream {
  if (
    upstream.type !== 'http' &&
    upstream.type !== 'http2' &&
    upstream.type !== 'ws'
  ) {
    throw new Error(`Unsupported Neem runtime upstream type [${upstream.type}]`)
  }
  const url = new URL(upstream.url)
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
  return { type: upstream.type, url: url.toString() }
}
```

- [ ] **Step 3: Run proxy tests**

Run:

```bash
pnpm --filter @nmtjs/neem test:unit -- --reporter=agent packages/neem/tests/unit/proxy.spec.ts
pnpm --filter @nmtjs/neem test:e2e -- --reporter=agent packages/neem/tests/e2e/recovery-health-proxy.spec.ts
```

Expected: PASS.

## Task 7: Final Verification

**Files:**
- No planned source edits in this task.

- [ ] **Step 1: Run Neem unit tests**

Run:

```bash
pnpm --filter @nmtjs/neem test:unit -- --reporter=agent
```

Expected: PASS.

- [ ] **Step 2: Run focused e2e tests**

Run:

```bash
pnpm --filter @nmtjs/neem test:e2e -- --reporter=agent packages/neem/tests/e2e/services.spec.ts packages/neem/tests/e2e/watcher-reload.spec.ts packages/neem/tests/e2e/recovery-health-proxy.spec.ts packages/neem/tests/e2e/declaration-errors.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm check:type --pretty false
```

Expected: PASS.

- [ ] **Step 4: Run lint**

Run:

```bash
pnpm oxlint . --format=agent
```

Expected: PASS, no warnings introduced.

## Self-Review

- Spec coverage: all kept/strengthened findings have a task. Dropped/weak findings are intentionally excluded or folded into larger roots.
- Placeholder scan: no TBD/TODO/fill-in steps remain.
- Type consistency: `BuildGroup` and `TargetChange` are array-first throughout; service wire requests retain `id` for correlation; caller-side ID hiding is optional and must stay low-churn; public `NeemRuntimeUpstream` remains unchanged.
