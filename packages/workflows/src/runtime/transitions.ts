import type {
  RuntimeAttemptStatus,
  RuntimeNodeStatus,
  RuntimeRunStatus,
} from './status.ts'

/**
 * The run/node/attempt state machines, declared in one place so both store
 * adapters enforce the same legal transitions instead of each hand-rolling
 * `status NOT IN (...)` guards that drift apart.
 */
export type TransitionMap<Status extends string> = Readonly<
  Record<Status, readonly Status[]>
>

export const RUN_TRANSITIONS: TransitionMap<RuntimeRunStatus> = {
  queued: ['running', 'cancelling', 'cancelled', 'failed', 'completed'],
  running: ['waiting', 'cancelling', 'cancelled', 'failed', 'completed'],
  waiting: ['running', 'cancelling', 'cancelled', 'failed', 'completed'],
  cancelling: ['cancelled', 'failed', 'completed'],
  completed: [],
  failed: [],
  cancelled: [],
}

export const NODE_TRANSITIONS: TransitionMap<RuntimeNodeStatus> = {
  pending: [
    'running',
    'waiting',
    'cancelling',
    'cancelled',
    'failed',
    'completed',
  ],
  running: ['waiting', 'cancelling', 'cancelled', 'failed', 'completed'],
  waiting: ['running', 'cancelling', 'cancelled', 'failed', 'completed'],
  cancelling: ['cancelled', 'failed', 'completed'],
  completed: [],
  failed: [],
  cancelled: [],
}

export const ATTEMPT_TRANSITIONS: TransitionMap<RuntimeAttemptStatus> = {
  started: ['completed', 'failed', 'timedOut', 'cancelled'],
  completed: [],
  failed: [],
  timedOut: [],
  cancelled: [],
}

export function canTransition<Status extends string>(
  transitions: TransitionMap<Status>,
  from: Status,
  to: Status,
): boolean {
  return transitions[from].includes(to)
}

/** Statuses from which `to` is legally reachable — the `WHERE status IN (...)` set. */
export function transitionSources<Status extends string>(
  transitions: TransitionMap<Status>,
  to: Status,
): readonly Status[] {
  return (Object.keys(transitions) as Status[]).filter((from) =>
    transitions[from].includes(to),
  )
}
