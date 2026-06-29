# Workflows Task Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tasks first-class durable runs so `workflows.start(task, input)`, workflow task nodes, branch/parallel task cases, and `mapTask` all expose real run IDs instead of internal attempt IDs.

**Architecture:** A `run` can represent either a workflow or a task. Workflow runs are advanced by the coordinator; task runs execute one task handler through internal attempts. Workflow nodes and composite children link to task runs the same way they link to workflow runs.

**Tech Stack:** TypeScript, Vitest, `@nmtjs/workflows` runtime interfaces, in-memory runtime test support, `@nmtjs/core` containers, `@nmtjs/type` schemas.

**Current status:** Task 1 is complete in `f2aaa1f7`. Task 2 is in progress in
the working tree. Task 3, Task 4, and Task 5 remain pending.

---

## File Structure

- Modify `packages/workflows/src/types/index.ts`
  - Add public run kind/type helpers.
  - Keep `mapTask` output run-based.
- Modify `packages/workflows/src/runtime/state.ts`
  - Add durable run kind/name fields.
  - Make child links target task or workflow runs.
- Modify `packages/workflows/src/runtime/store.ts`
  - Generalize child run creation from workflow-only to task/workflow.
- Modify `packages/workflows/src/runtime/commands.ts`
  - Keep attempts internal; make task attempt commands identify task runs cleanly.
- Modify `packages/workflows/tests/support/in-memory-runtime.ts`
  - Implement generalized task/workflow child run storage.
- Modify `packages/workflows/tests/runtime-interfaces.spec.ts`
  - Add type/export checks for task run contracts.
- Modify `packages/workflows/tests/runtime-store.spec.ts`
  - Add durable child task run idempotency tests.
- Modify `packages/workflows/tests/runtime-coordinator.spec.ts`
  - Change direct task, branch task, and parallel task tests to assert child task run links.
- Modify `packages/workflows/tests/runtime-worker.spec.ts`
  - Add task run completion behavior.
- Modify `packages/workflows/src/runtime/coordinator.ts`
  - Replace workflow-node task attempts with child task run creation.
- Modify `packages/workflows/src/runtime/worker.ts`
  - Complete task runs from task attempts without needing parent workflow implementation.

## Task 1: Types And Store Contracts

- [x] Add failing interface tests for `RunKind`, task run fields, and generic child run creation.
- [x] Update runtime state/store types.
- [x] Update in-memory store enough for store contract tests.
- [x] Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-interfaces.spec.ts tests/runtime-store.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

- [x] Commit:

```bash
git add packages/workflows/src/runtime packages/workflows/src/types packages/workflows/tests/runtime-interfaces.spec.ts packages/workflows/tests/runtime-store.spec.ts packages/workflows/tests/support/in-memory-runtime.ts
git commit -m "feat: model tasks as durable runs"
```

## Task 2: Direct Task Node Runtime

- [ ] Add failing coordinator/worker tests showing `.task(...)` creates a child task run and parent completes from that run output.
- [ ] Update coordinator to create/reuse child task runs for direct task nodes.
- [ ] Update task worker to complete task runs and wake parent runs.
- [ ] Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-coordinator.spec.ts tests/runtime-worker.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

- [ ] Commit:

```bash
git add packages/workflows/src/runtime packages/workflows/tests/runtime-coordinator.spec.ts packages/workflows/tests/runtime-worker.spec.ts packages/workflows/tests/support/in-memory-runtime.ts
git commit -m "feat: run workflow task nodes as child task runs"
```

## Task 3: Branch And Parallel Task Cases

- [ ] Add failing tests showing branch and parallel task cases create child task run links with `caseKey` or `memberKey`.
- [ ] Update branch and parallel dispatch to use child task runs for task cases.
- [ ] Keep activity cases as attempts and workflow cases as workflow runs.
- [ ] Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-coordinator.spec.ts tests/runtime-worker.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

- [ ] Commit:

```bash
git add packages/workflows/src/runtime packages/workflows/tests/runtime-coordinator.spec.ts packages/workflows/tests/runtime-worker.spec.ts packages/workflows/tests/support/in-memory-runtime.ts
git commit -m "feat: run composite task cases as child task runs"
```

## Task 4: MapTask Runtime

- [ ] Add failing tests for `mapTask` `wait-all` preserving item order and exposing child task run IDs.
- [ ] Implement item snapshotting, child task run creation, and convergence for `wait-all`.
- [ ] Add `wait-settled` only after `wait-all` passes; keep `start-only` as later slice if it complicates convergence.
- [ ] Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-coordinator.spec.ts tests/runtime-worker.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
pnpm oxlint . --format=agent
git diff --check
```

- [ ] Commit:

```bash
git add packages/workflows/src/runtime packages/workflows/src/types packages/workflows/tests
git commit -m "feat: run mapped tasks as child task runs"
```

## Task 5: Standalone Task Start

- [ ] Add failing tests showing `workflows.start(task, input)` creates a durable
      task run and dispatches an internal task attempt.
- [ ] Ensure standalone task completion marks the task run terminal without
      requiring a workflow coordinator continuation.
- [ ] Ensure parent-linked task runs still wake the parent workflow on terminal
      completion.
- [ ] Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-worker.spec.ts tests/runtime-store.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
pnpm oxlint . --format=agent
git diff --check
```

- [ ] Commit:

```bash
git add packages/workflows/src packages/workflows/tests
git commit -m "feat: start tasks as durable runs"
```

## Acceptance Criteria

- Task declarations can be started as durable runs.
- Workflow task nodes create child task runs, not public parent-node attempts.
- Branch/parallel task cases create child task runs with structured identity.
- `mapTask` output `runId` points to child task run IDs.
- Task attempts remain internal retry/lease records.
- Parent workflow implementations still do not import task implementations.
