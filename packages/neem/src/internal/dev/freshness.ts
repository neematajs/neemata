/**
 * A restart that found its runtime's worker output stale and could not refresh
 * it, so it waits for the worker's next successful build.
 *
 * - `restart`: the whole host restart (a new watcher or a plugin change).
 * - `reload`: one runtime reload; it also replaces a recovering runtime.
 * - `recovery`: host recovery of a crashed runtime, waiting on its output.
 */
export type DeferredRestart = 'recovery' | 'reload' | 'restart'

type RuntimeFreshness = { stale: boolean; pending?: DeferredRestart }

// A runtime holds one deferred restart, the one that covers the others: a
// reload releases a pending recovery, and a host restart replaces everything.
const COVERAGE: Record<DeferredRestart, number> = {
  recovery: 0,
  reload: 1,
  restart: 2,
}

/**
 * Per runtime of a dev session: is the worker output on disk at least as new
 * as the running generation, and which restart waits on it. Accepted patches
 * exist only in patch chunks, so restarts refresh stale output first.
 */
export class DevFreshness {
  private readonly runtimes = new Map<string, RuntimeFreshness>()

  isStale(runtimeName: string): boolean {
    return this.runtimes.get(runtimeName)?.stale ?? false
  }

  staleRuntimes(): string[] {
    return [...this.runtimes]
      .filter(([, record]) => record.stale)
      .map(([runtimeName]) => runtimeName)
  }

  /** The output on disk predates what the runtime runs or has to run next. */
  markStale(runtimeName: string): void {
    this.record(runtimeName).stale = true
  }

  /** The worker output was rewritten from the latest successful build. */
  outputRefreshed(runtimeName: string): void {
    const record = this.runtimes.get(runtimeName)
    if (record) record.stale = false
  }

  defer(runtimeName: string, restart: DeferredRestart): void {
    const record = this.record(runtimeName)
    if (!record.pending || COVERAGE[restart] > COVERAGE[record.pending]) {
      record.pending = restart
    }
  }

  /**
   * A runtime restart ran. A reload settles a deferred recovery of the same
   * runtime too, since it replaces the recovering runtime.
   */
  resume(runtimeName: string, restart: 'recovery' | 'reload'): void {
    const record = this.runtimes.get(runtimeName)
    if (record?.pending && COVERAGE[record.pending] <= COVERAGE[restart]) {
      record.pending = undefined
    }
  }

  /** The host restarted: nothing deferred remains for any runtime. */
  restarted(): void {
    for (const record of this.runtimes.values()) record.pending = undefined
  }

  /**
   * What a worker patch for this runtime resumes. The patch means the worker
   * builds again, so a restart deferred on its stale output can run now. A
   * deferred host restart is session-wide and wins over any runtime's own.
   */
  resumable(runtimeName: string): DeferredRestart | undefined {
    if (!this.isStale(runtimeName)) return undefined
    for (const record of this.runtimes.values()) {
      if (record.pending === 'restart') return 'restart'
    }
    return this.runtimes.get(runtimeName)?.pending
  }

  /** A new watcher cleans the output directory and builds it from scratch. */
  reset(): void {
    this.runtimes.clear()
  }

  private record(runtimeName: string): RuntimeFreshness {
    let record = this.runtimes.get(runtimeName)
    if (!record) {
      record = { stale: false }
      this.runtimes.set(runtimeName, record)
    }
    return record
  }
}
