import type {
  CancellationPolicy,
  DurationString,
  RetryPolicy,
} from '../model.ts'
import type { EffectSchema } from './codec.ts'
import type { Handler, InputOf, Labels, OutputOf } from './declaration.ts'
import type { Ref, Scope } from './ref.ts'
import type { AnyTask } from './task.ts'
import type { AnyWorkflow, ServedWorkflow } from './workflow.ts'
import { inputRef, stepRef } from './ref.ts'

declare const output: unique symbol
declare const services: unique symbol

type ActivityPolicy = Labels & {
  readonly retry?: RetryPolicy
  /** Limits one attempt of the activity. */
  readonly timeout?: DurationString
}

type TaskPolicy = Labels & {
  /** Overrides the task's retry policy for this step. */
  readonly retry?: RetryPolicy
  /** Overrides the task's attempt timeout for this step. */
  readonly timeout?: DurationString
}

type WorkflowPolicy = Labels & {
  readonly cancellation?: CancellationPolicy
}

/**
 * An activity is declared where it is used: a private step of its workflow,
 * run on the workflow's pool. `input` and `output` are its schemas, as in
 * `task(...)`, so the value it receives is named `from`.
 */
export type ActivityCall<Input, Output, R> = ActivityPolicy & {
  readonly input: EffectSchema<Input>
  readonly output: EffectSchema<Output>
  readonly from: Ref<NoInfer<Input>>
  readonly handler: Handler<R, NoInfer<Input>, NoInfer<Output>>
}

export type TaskCall<Input> = TaskPolicy & { readonly input: Ref<Input> }

export type WorkflowCall<Input> = WorkflowPolicy & {
  readonly input: Ref<Input>
}

/** Called when the engine starts one item, never while the workflow is built. */
export type ItemInput<Item, Input> = (item: Item, index: number) => Ref<Input>

export type MapCall<Item, Input> = {
  /** One item's schema; every item is stored through it. */
  readonly item: EffectSchema<Item>
  /** Resolved once, when the run reaches the step; may be empty. */
  readonly items: Ref<readonly NoInfer<Item>[]>
  readonly input: ItemInput<NoInfer<Item>, Input>
  /** At most this many items run at once; all of them when omitted. */
  readonly concurrency?: number
}

/** What a map step's reference holds: the items in their order. */
export type MapOutput<Item, Output> = {
  readonly items: readonly {
    readonly item: Item
    readonly index: number
    readonly runId: string
    readonly output: Output
  }[]
}

export type Leaf =
  | (ActivityPolicy & {
      readonly kind: 'activity'
      readonly schema: {
        readonly input: EffectSchema
        readonly output: EffectSchema
      }
      readonly input: Ref<unknown>
      // Erased: the builder checked the handler against both schemas.
      readonly handler: Handler<unknown, any, unknown>
    })
  | (TaskPolicy & {
      readonly kind: 'task'
      readonly task: AnyTask
      readonly input: Ref<unknown>
    })
  | (WorkflowPolicy & {
      readonly kind: 'workflow'
      readonly workflow: ServedWorkflow
      readonly input: Ref<unknown>
    })

/** Branch cases or parallel members, in declaration order. */
export type Leaves = readonly (readonly [key: string, leaf: Leaf])[]

type Mapped = Labels & {
  readonly item: EffectSchema
  readonly items: Ref<readonly unknown[]>
  // Erased like a handler: the builder checked it against the item schema.
  readonly input: ItemInput<any, unknown>
  readonly concurrency?: number
}

export type MapStep =
  | (Mapped & TaskPolicy & { readonly kind: 'mapTask'; readonly task: AnyTask })
  | (Mapped &
      WorkflowPolicy & {
        readonly kind: 'mapWorkflow'
        readonly workflow: ServedWorkflow
      })

export type Step =
  | Leaf
  | (Labels & {
      readonly kind: 'branch'
      readonly select: Ref<string>
      readonly cases: Leaves
    })
  | (Labels & { readonly kind: 'parallel'; readonly members: Leaves })
  | MapStep

/** A step in its place in a workflow: what `yield*` appended. */
export type Placed = Step & { readonly name: string }

/** A task or child workflow a step names, under its case or member key. */
export type StepTarget = {
  readonly caseKey?: string
  readonly target: AnyTask | ServedWorkflow
}

/** In case order: the order the graph lists them in. */
export function stepTargets(step: Step): readonly StepTarget[] {
  const own = (leaf: Leaf | MapStep): readonly StepTarget[] => {
    switch (leaf.kind) {
      case 'activity':
        return []
      case 'task':
      case 'mapTask':
        return [{ target: leaf.task }]
      case 'workflow':
      case 'mapWorkflow':
        return [{ target: leaf.workflow }]
    }
  }
  const keyed = (leaves: Leaves) =>
    leaves.flatMap(([caseKey, leaf]) =>
      own(leaf).map(({ target }) => ({ caseKey, target })),
    )

  switch (step.kind) {
    case 'branch':
      return keyed(step.cases)
    case 'parallel':
      return keyed(step.members)
    default:
      return own(step)
  }
}

/** What a worker must serve for a step to run. */
type Served<T, W> = {
  readonly tasks: readonly T[]
  readonly workflows: readonly W[]
}

/**
 * A branch case or parallel member: a detached description of one activity,
 * task or child workflow. It is not iterable, so it cannot be yielded into a
 * workflow's sequence, and it has no identity of its own, so one case plan may
 * serve several keys.
 */
export class CasePlan<
  out A,
  out T extends AnyTask = never,
  out W extends ServedWorkflow = never,
  out R = never,
> {
  /** Type-only: what the case produces. */
  declare readonly [output]?: A
  /** Type-only: the services its own activity requires. */
  declare readonly [services]?: R

  constructor(
    readonly leaf: Leaf,
    readonly served: Served<T, W>,
  ) {
    Object.freeze(this)
  }
}

type AnyCasePlan = CasePlan<unknown, AnyTask, ServedWorkflow, unknown>

type CasePlans = Record<string, AnyCasePlan>

type CaseKey<Cases> = Extract<keyof Cases, string>

type CaseOutput<Case> =
  Case extends CasePlan<infer A, any, any, any> ? A : never

type CaseTask<Cases extends CasePlans> =
  Cases[CaseKey<Cases>]['served']['tasks'][number]

type CaseWorkflow<Cases extends CasePlans> =
  Cases[CaseKey<Cases>]['served']['workflows'][number]

type CaseServices<Cases extends CasePlans> =
  Cases[CaseKey<Cases>] extends CasePlan<any, any, any, infer R> ? R : never

function caseActivity<Input, Output, R = never>(
  options: ActivityCall<Input, Output, R>,
): CasePlan<Output, never, never, R> {
  const { input, output, from, handler, ...policy } = options
  const schema = { input, output }
  const served = { tasks: [], workflows: [] }

  return new CasePlan(
    { ...policy, kind: 'activity', schema, input: from, handler },
    served,
  )
}

function caseTask<T extends AnyTask>(
  task: T,
  options: TaskCall<InputOf<T>>,
): CasePlan<OutputOf<T>, T> {
  const served = { tasks: [task], workflows: [] }

  return new CasePlan({ ...options, kind: 'task', task }, served)
}

function caseWorkflow<W extends AnyWorkflow>(
  workflow: W,
  options: WorkflowCall<InputOf<W>>,
): CasePlan<OutputOf<W>, W['tasks'][number], W['workflows'][number]> {
  return new CasePlan({ ...options, kind: 'workflow', workflow }, workflow)
}

const cases = Object.freeze({
  activity: caseActivity,
  task: caseTask,
  workflow: caseWorkflow,
})

export type CaseBuilder = typeof cases

/**
 * One named step of a workflow, detached until `yield*` places it. Creating a
 * plan adds nothing to the workflow; yielding it appends the step and returns
 * a reference to its output.
 */
export class Plan<
  out A,
  out T extends AnyTask = never,
  out W extends ServedWorkflow = never,
  out R = never,
> {
  /** Type-only: the services the step's own activities require. */
  declare readonly [services]?: R
  readonly #scope: Scope
  #ref: Ref<A> | undefined
  #delegated = false

  constructor(
    scope: Scope,
    readonly name: string,
    readonly step: Step,
    readonly served: Served<T, W>,
  ) {
    this.#scope = scope
  }

  *[Symbol.iterator](): Generator<Plan<A, T, W, R>, Ref<A>, unknown> {
    this.#delegated = true
    yield this
    if (!this.#ref) {
      throw new Error(
        `Plan [${this.name}] can only be yielded inside its workflow`,
      )
    }
    return this.#ref
  }

  /** Called by the workflow that receives this plan from its generator. */
  place(scope: Scope, index: number) {
    const label = `${scope.workflow}.${this.name}`

    if (this.#scope !== scope) {
      throw new Error(
        `Plan [${this.#scope.workflow}.${this.name}] belongs to another workflow and cannot be yielded in [${scope.workflow}]`,
      )
    }
    if (this.#ref) throw new Error(`Plan [${label}] was already yielded`)
    // A bare `yield` would place the step and hand back no reference.
    if (!this.#delegated) {
      throw new Error(`Plan [${label}] must be yielded with yield*`)
    }

    this.#ref = stepRef(scope, this.name, index)
  }
}

export type AnyPlan = Plan<unknown, AnyTask, ServedWorkflow, unknown>

/** The services the activities of these steps require, child workflows aside. */
export type PlanServices<P extends AnyPlan> =
  P extends Plan<any, any, any, infer R> ? R : never

export function createBuilder<Input>(
  scope: Scope,
  created: (plan: AnyPlan) => void,
) {
  function plan<A, T extends AnyTask, W extends ServedWorkflow, R>(
    name: string,
    step: Step,
    served: Served<T, W>,
  ) {
    const result = new Plan<A, T, W, R>(scope, name, step, served)
    created(result)
    return result
  }

  /** Unpacks the plans a `cases` or `members` callback returned. */
  function unpack<Cases extends CasePlans>(
    plans: Cases,
    name: string,
    owner: 'Branch case' | 'Parallel member',
    builder: 'cases' | 'members',
  ) {
    const leaves: [string, Leaf][] = []
    const tasks: CaseTask<Cases>[] = []
    const workflows: CaseWorkflow<Cases>[] = []

    for (const key in plans) {
      if (!Object.hasOwn(plans, key)) continue
      const member = plans[key]
      if (!(member instanceof CasePlan)) {
        throw new Error(
          `${owner} [${scope.workflow}.${name}.${key}] must be built with the ${builder} builder`,
        )
      }

      leaves.push([key, member.leaf])
      tasks.push(...member.served.tasks)
      workflows.push(...member.served.workflows)
    }

    return { leaves, served: { tasks, workflows } }
  }

  function activity<Input, Output, R = never>(
    name: string,
    options: ActivityCall<Input, Output, R>,
  ): Plan<Output, never, never, R> {
    const { leaf, served } = caseActivity(options)
    return plan(name, leaf, served)
  }

  function task<T extends AnyTask>(
    name: string,
    task: T,
    options: TaskCall<InputOf<T>>,
  ): Plan<OutputOf<T>, T> {
    const { leaf, served } = caseTask(task, options)
    return plan(name, leaf, served)
  }

  function workflow<W extends AnyWorkflow>(
    name: string,
    workflow: W,
    options: WorkflowCall<InputOf<W>>,
  ): Plan<OutputOf<W>, W['tasks'][number], W['workflows'][number]> {
    const { leaf, served } = caseWorkflow(workflow, options)
    return plan(name, leaf, served)
  }

  /**
   * Every case is built when the branch is declared; `select` picks the one
   * that runs. Cases are single activities, tasks or child workflows.
   */
  function branch<Cases extends CasePlans>(
    name: string,
    options: Labels & {
      readonly select: Ref<NoInfer<CaseKey<Cases>>>
      readonly cases: (p: CaseBuilder) => Cases
    },
  ): Plan<
    CaseOutput<Cases[CaseKey<Cases>]>,
    CaseTask<Cases>,
    CaseWorkflow<Cases>,
    CaseServices<Cases>
  > {
    const { cases: declare, ...declared } = options
    const { leaves, served } = unpack(
      declare(cases),
      name,
      'Branch case',
      'cases',
    )

    return plan(name, { ...declared, kind: 'branch', cases: leaves }, served)
  }

  /**
   * Every member runs, each as its own engine child; the step's output holds
   * each member's output under its key. Members cannot read one another.
   */
  function parallel<Members extends CasePlans>(
    name: string,
    options: Labels & { readonly members: (p: CaseBuilder) => Members },
  ): Plan<
    { readonly [Key in CaseKey<Members>]: CaseOutput<Members[Key]> },
    CaseTask<Members>,
    CaseWorkflow<Members>,
    CaseServices<Members>
  > {
    const { members: declare, ...labels } = options
    const { leaves, served } = unpack(
      declare(cases),
      name,
      'Parallel member',
      'members',
    )

    return plan(name, { ...labels, kind: 'parallel', members: leaves }, served)
  }

  /** Runs the task once per item; the output lists the items in their order. */
  function mapTask<T extends AnyTask, Item>(
    name: string,
    task: T,
    options: MapCall<Item, InputOf<T>> & TaskPolicy,
  ): Plan<MapOutput<Item, OutputOf<T>>, T> {
    const served = { tasks: [task], workflows: [] }

    return plan(name, { ...options, kind: 'mapTask', task }, served)
  }

  /** Starts the child workflow once per item, as `mapTask` does a task. */
  function mapWorkflow<W extends AnyWorkflow, Item>(
    name: string,
    workflow: W,
    options: MapCall<Item, InputOf<W>> & WorkflowPolicy,
  ): Plan<
    MapOutput<Item, OutputOf<W>>,
    W['tasks'][number],
    W['workflows'][number]
  > {
    return plan(name, { ...options, kind: 'mapWorkflow', workflow }, workflow)
  }

  /** The workflow input, readable at every step. */
  const input = inputRef<Input>(scope)

  return Object.freeze({
    input,
    activity,
    task,
    workflow,
    branch,
    parallel,
    mapTask,
    mapWorkflow,
  })
}

export type Builder<Input> = ReturnType<typeof createBuilder<Input>>
