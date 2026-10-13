import type { EffectSchema } from '@nmtjs/common/effect'

import type { ActivityHandler } from '../effect/implement.ts'
import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type {
  AnyWorkflowDefinition,
  CancellationPolicy,
  DurationString,
  MapNodeOutput,
  RetryPolicy,
  TaskInput,
  TaskOutput,
  WorkflowInput,
  WorkflowOutput,
} from '../types/index.ts'
import type { Deferred, Read, Scope, Value } from './ref.ts'
import type { AnyTask } from './task.ts'
import type { AnyWorkflow } from './workflow.ts'
import { Ref } from './ref.ts'

declare const output: unique symbol
declare const services: unique symbol

type Metadata = {
  readonly title?: string
  readonly description?: string
}

type ActivityPolicy = Metadata & {
  readonly retry?: RetryPolicy
  /** Limits one attempt of the activity. */
  readonly timeout?: DurationString
}

type TaskPolicy = Metadata & {
  /** Overrides the task's retry policy for this step. */
  readonly retry?: RetryPolicy
  /** Overrides the task's attempt timeout for this step. */
  readonly timeout?: DurationString
}

type WorkflowPolicy = Metadata & {
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
  readonly from: Value<NoInfer<Input>>
  readonly handler: ActivityHandler<R, NoInfer<Input>, NoInfer<Output>>
}

export type TaskCall<Input> = TaskPolicy & { readonly input: Value<Input> }

export type WorkflowCall<Input> = WorkflowPolicy & {
  readonly input: Value<Input>
}

/** Runs when the engine starts one item, never while the workflow is built. */
export type ItemInput<Item, Input> = (
  read: Read,
  item: Item,
  index: number,
) => Input

export type MapCall<Item, Input> = {
  /** One item's schema; the engine stores every item through it. */
  readonly item: EffectSchema<Item>
  /** Resolved once, when the run reaches the step; may be empty. */
  readonly items: Value<readonly NoInfer<Item>[]>
  readonly input: ItemInput<NoInfer<Item>, Input>
  /** At most this many items run at once; all of them when omitted. */
  readonly concurrency?: number
}

type Mapped = {
  readonly items: Value<readonly unknown[]>
  // Erased like the handler below: the builder checked it against the schema.
  readonly input: ItemInput<any, unknown>
}

type MapOptions<Policy> = Policy & {
  readonly item: EffectSchema
  readonly concurrency?: number
}

export type Leaf =
  | {
      readonly kind: 'activity'
      readonly schema: {
        readonly input: EffectSchema
        readonly output: EffectSchema
      }
      readonly input: Value<unknown>
      // Erased: the builder checked the handler against both schemas.
      readonly handler: ActivityHandler<unknown, any, unknown>
      readonly policy: ActivityPolicy
    }
  | {
      readonly kind: 'task'
      readonly task: AnyTask
      readonly input: Value<unknown>
      readonly policy: TaskPolicy
    }
  | {
      readonly kind: 'workflow'
      readonly workflow: AnyWorkflow
      readonly input: Value<unknown>
      readonly policy: WorkflowPolicy
    }

/** Branch cases or parallel members, in declaration order. */
export type Leaves = readonly (readonly [key: string, leaf: Leaf])[]

export type Branch = {
  readonly kind: 'branch'
  readonly select: Deferred<string>
  readonly cases: Leaves
  readonly metadata: Metadata
}

export type Parallel = {
  readonly kind: 'parallel'
  readonly cases: Leaves
  readonly metadata: Metadata
}

export type MapStep =
  | (Mapped & {
      readonly kind: 'mapTask'
      readonly task: AnyTask
      /** What the contract declares for the node. */
      readonly options: MapOptions<TaskPolicy>
    })
  | (Mapped & {
      readonly kind: 'mapWorkflow'
      readonly workflow: AnyWorkflow
      readonly options: MapOptions<WorkflowPolicy>
    })

export type Step = Leaf | Branch | Parallel | MapStep

/**
 * The bound of every served workflow implementation. A list typed with it
 * would switch off the worker's check of the services activities require, so
 * lists keep the implementations' own types.
 */
export type ServedWorkflow = WorkflowImplementation<AnyWorkflowDefinition, any>

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
  out T extends TaskImplementation = never,
  out W extends ServedWorkflow = never,
  out R = never,
> {
  /** Type-only: what the case produces. */
  declare readonly [output]?: A
  /** Type-only: the services its own activity requires. */
  declare readonly [services]: R

  constructor(
    readonly leaf: Leaf,
    readonly served: Served<T, W>,
  ) {
    Object.freeze(this)
  }
}

type AnyCasePlan = CasePlan<
  unknown,
  TaskImplementation,
  ServedWorkflow,
  unknown
>

type CasePlans = Record<string, AnyCasePlan>

type CaseKey<Cases> = Extract<keyof Cases, string>

type CaseOutput<Case> =
  Case extends CasePlan<infer A, any, any, any> ? A : never

type CaseTask<Cases extends CasePlans> =
  Cases[CaseKey<Cases>]['served']['tasks'][number]

type CaseWorkflow<Cases extends CasePlans> =
  Cases[CaseKey<Cases>]['served']['workflows'][number]

type CaseServices<Cases extends CasePlans> =
  Cases[CaseKey<Cases>][typeof services]

function caseActivity<Args, Result, R = never>(
  options: ActivityCall<Args, Result, R>,
): CasePlan<Result, never, never, R> {
  const { input, output, from, handler, ...policy } = options
  const schema = { input, output }
  const served = { tasks: [], workflows: [] }

  return new CasePlan(
    { kind: 'activity', schema, input: from, handler, policy },
    served,
  )
}

function caseTask<T extends AnyTask>(
  task: T,
  options: TaskCall<TaskInput<T['contract']>>,
): CasePlan<TaskOutput<T['contract']>, T['implementation']> {
  const { input, ...policy } = options
  const served = { tasks: [task.implementation], workflows: [] }

  return new CasePlan({ kind: 'task', task, input, policy }, served)
}

function caseWorkflow<W extends AnyWorkflow>(
  workflow: W,
  options: WorkflowCall<WorkflowInput<W['contract']>>,
): CasePlan<
  WorkflowOutput<W['contract']>,
  W['tasks'][number],
  W['workflows'][number]
> {
  const { input, ...policy } = options

  return new CasePlan({ kind: 'workflow', workflow, input, policy }, workflow)
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
  out T extends TaskImplementation = never,
  out W extends ServedWorkflow = never,
  out R = never,
> {
  /** Type-only: the services the step's own activities require. */
  declare readonly [services]: R
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

    this.#ref = new Ref(scope, this.name, index)
  }
}

export type AnyPlan = Plan<unknown, TaskImplementation, ServedWorkflow, unknown>

/** The services the activities of these steps require, child workflows aside. */
export type Services<P extends AnyPlan> = P[typeof services]

export function createBuilder<Input>(
  scope: Scope,
  created: (plan: AnyPlan) => void,
) {
  function plan<A, T extends TaskImplementation, W extends ServedWorkflow, R>(
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

  function activity<Args, Result, R = never>(
    name: string,
    options: ActivityCall<Args, Result, R>,
  ): Plan<Result, never, never, R> {
    const { leaf, served } = caseActivity(options)
    return plan(name, leaf, served)
  }

  function task<T extends AnyTask>(
    name: string,
    task: T,
    options: TaskCall<TaskInput<T['contract']>>,
  ): Plan<TaskOutput<T['contract']>, T['implementation']> {
    const { leaf, served } = caseTask(task, options)
    return plan(name, leaf, served)
  }

  function workflow<W extends AnyWorkflow>(
    name: string,
    workflow: W,
    options: WorkflowCall<WorkflowInput<W['contract']>>,
  ): Plan<
    WorkflowOutput<W['contract']>,
    W['tasks'][number],
    W['workflows'][number]
  > {
    const { leaf, served } = caseWorkflow(workflow, options)
    return plan(name, leaf, served)
  }

  /**
   * Every case is built when the branch is declared; `select` picks the one
   * that runs. Cases are single activities, tasks or child workflows.
   */
  function branch<Cases extends CasePlans>(
    name: string,
    options: Metadata & {
      readonly select: Deferred<NoInfer<CaseKey<Cases>>>
      readonly cases: (p: CaseBuilder) => Cases
    },
  ): Plan<
    CaseOutput<Cases[CaseKey<Cases>]>,
    CaseTask<Cases>,
    CaseWorkflow<Cases>,
    CaseServices<Cases>
  > {
    const { select, cases: declare, ...metadata } = options
    const { leaves, served } = unpack(
      declare(cases),
      name,
      'Branch case',
      'cases',
    )

    return plan(
      name,
      { kind: 'branch', select, cases: leaves, metadata },
      served,
    )
  }

  /**
   * Every member runs, each as its own engine child; the step's output holds
   * each member's output under its key. Members cannot read one another.
   */
  function parallel<Members extends CasePlans>(
    name: string,
    options: Metadata & { readonly members: (p: CaseBuilder) => Members },
  ): Plan<
    { readonly [Key in CaseKey<Members>]: CaseOutput<Members[Key]> },
    CaseTask<Members>,
    CaseWorkflow<Members>,
    CaseServices<Members>
  > {
    const { members: declare, ...metadata } = options
    const { leaves, served } = unpack(
      declare(cases),
      name,
      'Parallel member',
      'members',
    )

    return plan(name, { kind: 'parallel', cases: leaves, metadata }, served)
  }

  /** Runs the task once per item; the output lists the items in their order. */
  function mapTask<T extends AnyTask, Item>(
    name: string,
    task: T,
    options: MapCall<Item, TaskInput<T['contract']>> & TaskPolicy,
  ): Plan<MapNodeOutput<Item, TaskOutput<T['contract']>>, T['implementation']> {
    const { items, input, ...declared } = options
    const served = { tasks: [task.implementation], workflows: [] }

    return plan(
      name,
      { kind: 'mapTask', task, items, input, options: declared },
      served,
    )
  }

  /** Starts the child workflow once per item, as `mapTask` does a task. */
  function mapWorkflow<W extends AnyWorkflow, Item>(
    name: string,
    workflow: W,
    options: MapCall<Item, WorkflowInput<W['contract']>> & WorkflowPolicy,
  ): Plan<
    MapNodeOutput<Item, WorkflowOutput<W['contract']>>,
    W['tasks'][number],
    W['workflows'][number]
  > {
    const { items, input, ...declared } = options

    return plan(
      name,
      { kind: 'mapWorkflow', workflow, items, input, options: declared },
      workflow,
    )
  }

  /** The workflow input, readable in every deferred callback. */
  const input = Ref.input<Input>(scope)

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
