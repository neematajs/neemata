import { createHash } from 'node:crypto'

import { valueKey } from './state.ts'

const digest = (value: unknown) =>
  createHash('sha256').update(valueKey(value)).digest('base64url')

export class Keys {
  constructor(readonly prefix: string) {}

  family(rootRunId: string) {
    return `${this.prefix}family:${rootRunId}`
  }

  familyRuns(rootRunId: string) {
    return `${this.family(rootRunId)}:runs`
  }

  familyNodes(rootRunId: string) {
    return `${this.family(rootRunId)}:nodes`
  }

  familyChildren(rootRunId: string) {
    return `${this.family(rootRunId)}:children`
  }

  familyAttempts(rootRunId: string) {
    return `${this.family(rootRunId)}:attempts`
  }

  familyLeases(rootRunId: string) {
    return `${this.family(rootRunId)}:leases`
  }

  familyOrders(rootRunId: string) {
    return `${this.family(rootRunId)}:orders`
  }

  familyIndexes(rootRunId: string) {
    return `${this.family(rootRunId)}:indexes`
  }

  familySignatures(rootRunId: string) {
    return `${this.family(rootRunId)}:signatures`
  }

  familyStateKeys(rootRunId: string) {
    return [
      this.family(rootRunId),
      this.familyRuns(rootRunId),
      this.familyNodes(rootRunId),
      this.familyChildren(rootRunId),
      this.familyAttempts(rootRunId),
      this.familyLeases(rootRunId),
      this.familyOrders(rootRunId),
      this.familyIndexes(rootRunId),
      this.familySignatures(rootRunId),
    ] as const
  }

  runRoot(runId: string) {
    return `${this.prefix}run-root:${runId}`
  }

  attemptRoot(attemptId: string) {
    return `${this.prefix}attempt-root:${attemptId}`
  }

  startDispatch(runId: string) {
    return `${this.prefix}start-dispatch:${runId}`
  }

  idempotency(value: readonly unknown[]) {
    return `${this.prefix}idempotency:${digest(value)}`
  }

  unique(scope: 'active' | 'all', value: readonly unknown[]) {
    return `${this.prefix}unique:${scope}:${digest(value)}`
  }

  activeRuns() {
    return `${this.prefix}runs:active`
  }

  orderedRuns() {
    return `${this.prefix}runs:ordered`
  }

  terminalRuns() {
    return `${this.prefix}runs:terminal`
  }

  runSequence() {
    return `${this.prefix}runs:sequence`
  }

  queue(kind: 'continue' | 'attempt') {
    const base = `${this.prefix}queue:${kind}`
    return {
      items: `${base}:items`,
      ready: `${base}:ready`,
      claimed: `${base}:claimed`,
      dead: `${base}:dead`,
      dedup: `${base}:dedup`,
    }
  }

  commandWake(kind: 'continue' | 'activity' | 'task') {
    return `${this.prefix}wake:command:${kind}`
  }

  cancellationWake(runId: string) {
    return `${this.prefix}wake:cancel:${runId}`
  }

  runWake(rootRunId: string) {
    return `${this.prefix}wake:run:${rootRunId}`
  }
}
