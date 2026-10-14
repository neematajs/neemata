import type * as Scope from 'effect/Scope'

import type { Services } from '../dsl/declaration.ts'
import type { AnySchedule } from '../dsl/schedule.ts'
import type { AnyTask } from '../dsl/task.ts'
import type { ServedWorkflow } from '../dsl/workflow.ts'
import type { Registry } from '../program.ts'
import { stepTargets } from '../dsl/plan.ts'
import { registry } from '../program.ts'

/** The declarations a worker is given: it serves these, and no others. */
export type Served<
  W extends ServedWorkflow = ServedWorkflow,
  T extends AnyTask = AnyTask,
> = {
  readonly workflows?: readonly W[]
  readonly tasks?: readonly T[]
}

/**
 * What the handlers a pool runs require: a workflow's own activities run on
 * the workflow's pool, a task on its own. A declaration whose pool is not
 * known to the type level counts for every pool, as does every declaration
 * for a worker that names none.
 *
 * A `Scope` is not among them: every handler is given one of its own, which
 * lasts for its attempt.
 */
export type PoolServices<D, Pool extends string> = D extends {
  readonly pool: infer Declared
}
  ? [Pool & Declared] extends [never]
    ? never
    : Exclude<Services<D>, Scope.Scope>
  : never

/** The programs of what a worker serves, on `pool` when it names one. */
export function serving(
  { workflows = [], tasks = [] }: Served,
  pool?: string,
): Registry {
  const declarations = [...workflows, ...tasks]
  return registry(
    declarations
      .filter((declaration) => pool === undefined || declaration.pool === pool)
      .map(({ program }) => program),
  )
}

type Declaration = AnyTask | ServedWorkflow

const routeLabel = ({ name, revision }: Declaration) =>
  revision === undefined ? name : `${name}@${revision}`

const routeKey = ({ kind, name, revision }: Declaration) =>
  JSON.stringify([kind, name, revision ?? null])

const listed = (names: ReadonlySet<string>) => Array.from(names).join(', ')

/**
 * Checks that what a deployment serves is complete, before any worker starts.
 * A gap would leave durable commands waiting forever, and workers accept
 * partial lists on purpose, so a host calls this once with everything its
 * workers serve between them. Revisions of one name are separate entries:
 * each needs its own declaration and its own targets.
 *
 * What a schedule starts runs of is a target as much as what a step calls:
 * a schedule fires whether or not any worker has code for its run.
 */
export function verify({
  workflows = [],
  tasks = [],
  schedules = [],
  pools,
}: Served & {
  /** The schedules the deployment's coordinators are given. */
  readonly schedules?: readonly AnySchedule[]
  /** The pools the deployment runs workers for; unchecked when omitted. */
  readonly pools?: readonly string[]
}): void {
  const registered = new Map<string, Declaration>()
  const duplicates = new Set<string>()
  for (const declaration of [...workflows, ...tasks]) {
    const key = routeKey(declaration)
    if (registered.has(key)) {
      duplicates.add(`${declaration.kind}:${routeLabel(declaration)}`)
    }
    registered.set(key, declaration)
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Declarations [${listed(duplicates)}] are registered more than once; a workflow or task is registered once per revision`,
    )
  }

  // A run is started by route, so a copy of a declaration would be written
  // with one schema and read with another.
  const complete = (targets: Iterable<Declaration>, referrers: string) => {
    const missing = { workflow: new Set<string>(), task: new Set<string>() }
    const copies = new Set<string>()
    for (const target of new Set(targets)) {
      const known = registered.get(routeKey(target))
      if (!known) missing[target.kind].add(routeLabel(target))
      else if (known !== target) copies.add(routeLabel(target))
    }
    if (missing.workflow.size > 0) {
      throw new Error(
        `Workflows [${listed(missing.workflow)}] referenced by ${referrers} are not registered`,
      )
    }
    if (missing.task.size > 0) {
      throw new Error(
        `Tasks [${listed(missing.task)}] referenced by ${referrers} are not registered`,
      )
    }
    if (copies.size > 0) {
      throw new Error(
        `Declarations [${listed(copies)}] exist as more than one object; a reference and what is registered must be one declaration`,
      )
    }
  }
  complete(
    workflows.flatMap(({ steps }) =>
      steps.flatMap((step) => stepTargets(step).map(({ target }) => target)),
    ),
    'registered workflows',
  )
  complete(
    schedules.map(({ runnable }) => runnable),
    'schedules',
  )

  if (!pools) return
  const undeclared = new Set<string>()
  for (const { pool } of registered.values()) {
    if (!pools.includes(pool)) undeclared.add(pool)
  }
  if (undeclared.size > 0) {
    throw new Error(
      `Execution pools [${listed(undeclared)}] named by declarations are not declared`,
    )
  }
}
