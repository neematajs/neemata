import type { EffectSchema } from '@nmtjs/common/effect'

import type {
  BranchCaseHelpers,
  WorkflowBuilder,
  WorkflowOptions,
} from '../contract/index.ts'
import type { EffectSchemaKind } from '../effect/codec.ts'
import type { HandlerRuntime } from '../effect/handler.ts'
import type {
  MapNodeImplementation,
  TaskImplementation,
  WorkflowCaseImplementation,
  WorkflowImplementation,
  WorkflowNodeImplementation,
} from '../implement/index.ts'
import type {
  BranchCaseDefinition,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowOutput,
} from '../types/index.ts'
import type {
  AnyPlan,
  Builder,
  Leaf,
  Leaves,
  MapStep,
  ServedWorkflow,
  Services,
  Step,
} from './plan.ts'
import type { Outputs, Position, Scope, Value } from './ref.ts'
import { defineWorkflow } from '../effect/contract.ts'
import { storedHandler } from '../effect/implement.ts'
import { createBuilder, Plan } from './plan.ts'
import { assertValue, reader, resolve } from './ref.ts'

/**
 * A workflow declared once: its existing contract, its existing implementation
 * and everything a worker must serve for it to run.
 */
export type Workflow<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  T extends TaskImplementation = never,
  W extends ServedWorkflow = never,
  R = never,
> = {
  readonly contract: Contract<Name, Input, Output>
  readonly implementation: Implementation<Name, Input, Output, R>
  /** This workflow and every child workflow it can start. */
  readonly workflows: readonly (Implementation<Name, Input, Output, R> | W)[]
  /** Every task this workflow or its child workflows can start. */
  readonly tasks: readonly T[]
}

export type AnyWorkflow = Workflow<
  string,
  any,
  any,
  TaskImplementation,
  ServedWorkflow,
  any
>

type Contract<Name extends string, Input, Output> = WorkflowDefinition<
  Name,
  Input,
  Output
>

/**
 * `R` is the services of the workflow's own activities, carried as the existing
 * Effect implementer carries them: a worker serving this implementation must
 * provide them. A workflow without activities requires nothing.
 */
type Implementation<
  Name extends string,
  Input,
  Output,
  R,
> = WorkflowImplementation<Contract<Name, Input, Output>, HandlerRuntime<R>>

type Draft<Name extends string, Input, Output> = WorkflowBuilder<
  Name,
  Input,
  readonly WorkflowNode[],
  Output,
  EffectSchemaKind
>

/**
 * Runs `body` once, now, to collect its steps. Handlers and deferred callbacks
 * are stored, not called. Plain JavaScript in the body runs like any other
 * code, so it must not branch on a reference: use `w.branch`.
 */
export function workflow<
  Name extends string,
  Input,
  Output,
  Y extends AnyPlan = never,
>(
  options: WorkflowOptions<
    EffectSchemaKind,
    Name,
    EffectSchema<Input>,
    EffectSchema<Output>
  > & {
    readonly output: EffectSchema<Output>
    /**
     * The pool of the generated implementation, where its activities run.
     * Tasks and child workflows run where their own declarations say.
     */
    readonly pool: string
  },
  // The result is typed through the contract, as the existing finish handler
  // reads it: the schemas alone decide Input and Output, never the body.
  body: (
    w: Builder<NoInfer<Input>>,
  ) => Generator<
    Y,
    Value<WorkflowOutput<Contract<Name, Input, Output>>>,
    unknown
  >,
): Workflow<
  Name,
  Input,
  Output,
  Y['served']['tasks'][number],
  Y['served']['workflows'][number],
  Services<Y>
> {
  const { pool, ...declared } = options
  const { name } = declared
  const scope: Scope = { workflow: name }
  const pending = new Set<AnyPlan>()
  const steps: Y[] = []
  const nodes: WorkflowNodeImplementation[] = []
  let draft: Draft<Name, Input, Output> = defineWorkflow(declared)

  const iterator = body(createBuilder(scope, (plan) => pending.add(plan)))
  let next = iterator.next()

  while (!next.done) {
    const plan = next.value
    if (!(plan instanceof Plan)) {
      throw new Error(
        `Workflow [${name}] can only yield plans created by its builder`,
      )
    }

    const at = { scope, limit: steps.length, label: `${name}.${plan.name}` }
    plan.place(scope, at.limit)
    pending.delete(plan)
    draft = declare(draft, plan.name, plan.step)
    nodes.push(implement(plan.name, plan.step, at))
    steps.push(plan)
    next = iterator.next()
  }

  // A plan that was created and dropped is almost always a missing `yield*`.
  if (pending.size > 0) {
    const names = Array.from(pending, (plan) => plan.name).join(', ')
    throw new Error(`Workflow [${name}] never yielded its plans: ${names}`)
  }

  const result = next.value
  const end = { scope, limit: steps.length, label: `${name} result` }
  assertValue(result, end)

  // `build` types the output through a conditional TypeScript cannot resolve
  // for a generic Output, so the type-only field is dropped and the definition
  // is typed from its remaining fields.
  const { _types, ...definition } = draft.build()
  const contract: Contract<Name, Input, Output> = Object.freeze(definition)

  // The typed implementation chain exposes one method per literal node name and
  // cannot be driven from a list, so this assembles the value it produces.
  const implementation: Implementation<
    Name,
    Input,
    Output,
    Services<Y>
  > = Object.freeze({
    kind: 'workflowImplementation',
    workflow: contract,
    pool,
    nodes: Object.freeze(nodes),
    finish: (outputs: Outputs, input: unknown) =>
      resolve(result, end, outputs, input),
  })

  const workflows = new Set<
    typeof implementation | Y['served']['workflows'][number]
  >([implementation])
  const tasks = new Set<Y['served']['tasks'][number]>()

  for (const { served } of steps) {
    for (const child of served.workflows) workflows.add(child)
    for (const task of served.tasks) tasks.add(task)
  }

  return Object.freeze({
    contract,
    implementation,
    workflows: Array.from(workflows),
    tasks: Array.from(tasks),
  })
}

function declare<Name extends string, Input, Output>(
  draft: Draft<Name, Input, Output>,
  name: string,
  step: Step,
): Draft<Name, Input, Output> {
  switch (step.kind) {
    case 'activity':
      return draft.activity(name, { ...step.schema, ...step.policy })
    case 'task':
      return draft.task(name, step.task.contract, step.policy)
    case 'workflow':
      return draft.workflow(name, step.workflow.contract, step.policy)
    case 'branch':
      return draft.branch(name, {
        ...step.metadata,
        cases: (helpers) => declareCases(helpers, step.cases),
      })
    case 'parallel':
      return draft.parallel(
        name,
        (helpers) => declareCases(helpers, step.cases),
        step.metadata,
      )
    case 'mapTask':
      return draft.mapTask(name, step.task.contract, step.options)
    case 'mapWorkflow':
      return draft.mapWorkflow(name, step.workflow.contract, step.options)
  }
}

type CaseHelpers = BranchCaseHelpers<EffectSchemaKind>

function declareCases(helpers: CaseHelpers, leaves: Leaves) {
  // Assigning `__proto__` to a plain object sets its prototype instead of a
  // key, which would hide it from the contract builder's reserved-key check.
  const declared: Record<string, BranchCaseDefinition> = Object.create(null)

  for (const [key, leaf] of leaves) declared[key] = declareCase(helpers, leaf)

  return declared
}

function declareCase(helpers: CaseHelpers, leaf: Leaf): BranchCaseDefinition {
  switch (leaf.kind) {
    case 'activity':
      return helpers.activity({ ...leaf.schema, ...leaf.policy })
    case 'task':
      return helpers.task(leaf.task.contract, leaf.policy)
    case 'workflow':
      return helpers.workflow(leaf.workflow.contract, leaf.policy)
  }
}

function implement(
  name: string,
  step: Step,
  at: Position,
): WorkflowNodeImplementation {
  switch (step.kind) {
    case 'branch': {
      const select = (outputs: Outputs, input: unknown) =>
        resolve(step.select, at, outputs, input)
      const cases = implementCases(name, step.cases, at)

      return Object.freeze({ kind: 'branch', name, select, cases })
    }
    case 'parallel': {
      const cases = implementCases(name, step.cases, at)

      return Object.freeze({ kind: 'parallel', name, cases })
    }
    case 'mapTask':
    case 'mapWorkflow':
      return implementMap(name, step, at)
    default:
      return implementLeaf(name, step, at)
  }
}

/** Cases and members read what the step itself may read: nothing later. */
function implementCases(name: string, leaves: Leaves, at: Position) {
  const cases: Record<string, WorkflowCaseImplementation> = Object.create(null)

  for (const [key, leaf] of leaves) {
    const label = `${at.label}.${key}`
    cases[key] = implementLeaf(`${name}.${key}`, leaf, { ...at, label })
  }

  return Object.freeze(cases)
}

function implementLeaf(
  name: string,
  leaf: Leaf,
  at: Position,
): WorkflowCaseImplementation {
  assertValue(leaf.input, at)
  const input = (outputs: Outputs, input: unknown) =>
    resolve(leaf.input, at, outputs, input)

  switch (leaf.kind) {
    case 'activity': {
      // Types rule this out; untyped callers get a build error, not a run failure.
      if (typeof leaf.handler !== 'function') {
        throw new Error(`Missing activity handler [${at.label}]`)
      }

      const handler = storedHandler(leaf.handler)
      const activity = Object.freeze({
        kind: 'activityImplementation',
        name,
        handler,
      })
      const { retry } = leaf.policy

      return Object.freeze({ kind: 'activity', name, activity, retry, input })
    }
    case 'task': {
      const target = leaf.task.contract
      const { retry } = leaf.policy

      return Object.freeze({ kind: 'task', name, target, retry, input })
    }
    case 'workflow': {
      const target = leaf.workflow.contract

      return Object.freeze({ kind: 'workflow', name, target, input })
    }
  }
}

/**
 * The engine calls `items` once and `input` once per item, when it starts that
 * item; both read the outputs that existed before the map.
 */
function implementMap(
  name: string,
  step: MapStep,
  at: Position,
): MapNodeImplementation {
  assertValue(step.items, at)
  if (typeof step.input !== 'function') {
    throw new Error(
      `[${at.label}] needs an input callback for its items, received ${typeof step.input}`,
    )
  }

  const target =
    step.kind === 'mapTask' ? step.task.contract : step.workflow.contract
  const { concurrency } = step.options
  const items = (outputs: Outputs, input: unknown) =>
    resolve(step.items, at, outputs, input)
  const input = (
    outputs: Outputs,
    item: unknown,
    input: unknown,
    index: number,
  ) => step.input(reader(at, outputs, input), item, index)

  return Object.freeze({
    kind: step.kind,
    name,
    target,
    concurrency,
    items,
    input,
  })
}
