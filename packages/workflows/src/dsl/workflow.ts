import * as Schema from 'effect/Schema'

import type { Route } from '../model.ts'
import type {
  Compute,
  Outputs,
  Program,
  Leaf as ProgramLeaf,
  Step as ProgramStep,
  Selected,
  Target,
  WorkflowProgram,
} from '../program.ts'
import type { Declared, Options } from './declaration.ts'
import type {
  AnyPlan,
  Builder,
  Leaf,
  Leaves,
  MapStep,
  Placed,
  PlanServices,
} from './plan.ts'
import type { Position, Read, Ref, Scope } from './ref.ts'
import type { AnyTask } from './task.ts'
import { describe } from '../graph/revision.ts'
import { boundary } from './codec.ts'
import { assertRevision, route } from './declaration.ts'
import { createBuilder, Plan, stepTargets } from './plan.ts'
import { assertValue, INPUT, resolve } from './ref.ts'
import { execution } from './task.ts'

/**
 * A workflow as a worker serves it: its steps, its program and the services
 * its own activities require, whatever it can start.
 */
export type ServedWorkflow<
  Name extends string = string,
  Input = any,
  Output = any,
  R = any,
  Pool extends string = string,
> = Declared<'workflow', Name, Input, Output, R, WorkflowProgram, Pool> & {
  /** In the order they were yielded, which is the order they run in. */
  readonly steps: readonly Placed[]
}

/** A workflow declared once, with everything a worker must serve to run it. */
export type Workflow<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  T extends AnyTask = never,
  W extends ServedWorkflow = never,
  R = never,
  Pool extends string = string,
> = ServedWorkflow<Name, Input, Output, R, Pool> & {
  /** This workflow and every child workflow it can start, each once. */
  readonly workflows: readonly (
    | ServedWorkflow<Name, Input, Output, R, Pool>
    | W
  )[]
  /** Every task this workflow or its child workflows can start, each once. */
  readonly tasks: readonly T[]
  /** The programs of `workflows` and `tasks`: what a registry takes. */
  readonly programs: readonly Program[]
}

export type AnyWorkflow = Workflow<
  string,
  any,
  any,
  AnyTask,
  ServedWorkflow,
  any
>

/** The decoded values one pass may read, from what it has stored. */
type Reading = (outputs: Outputs, input: unknown, selected: Selected) => Read

type Decode = (stored: unknown, selectedCase?: string) => unknown

/** What the engine runs for a step, and how that step's output is read back. */
type Lowered<S> = { readonly step: S; readonly decode: Decode }

/**
 * Runs `body` once, now, to collect its steps. Handlers are stored and no
 * reference is run: there is no run yet to read from. Plain JavaScript in the
 * body runs like any other code, so it must not branch on a reference: use
 * `w.branch`.
 */
export function workflow<
  Name extends string,
  Input,
  Output,
  Y extends AnyPlan = never,
  Pool extends string = string,
>(
  options: Options<Name, Input, Output, Pool>,
  // The schemas alone decide Input and Output, never the body.
  body: (
    w: Builder<NoInfer<Input>>,
  ) => Generator<Y, Ref<NoInfer<Output>>, unknown>,
): Workflow<
  Name,
  Input,
  Output,
  Y['served']['tasks'][number],
  Y['served']['workflows'][number],
  PlanServices<Y>,
  Pool
> {
  assertRevision('workflow', options)
  const { input: from, output: to, ...declared } = options
  const { name } = options
  const input = boundary(from, `workflow input [${name}]`)
  const output = boundary(to, `workflow output [${name}]`)
  const scope: Scope = { workflow: name }
  const pending = new Set<AnyPlan>()
  const plans: Y[] = []
  const steps: Placed[] = []
  const lowered: Lowered<ProgramStep>[] = []

  // The values of one pass are computed from one `outputs` object, a map's
  // inputs once per item: a source is decoded once for all of them, for as
  // long as the same stored value stands behind it.
  const passes = new WeakMap<
    Outputs,
    Map<number, { readonly stored: unknown; readonly value: unknown }>
  >()
  const reading: Reading = (outputs, storedInput, selected) => {
    const pass = passes.get(outputs) ?? new Map()
    passes.set(outputs, pass)

    return ({ name: step, index }) => {
      const stored = index === INPUT ? storedInput : outputs[step]
      const known = pass.get(index)
      if (known && Object.is(known.stored, stored)) return known.value

      const value =
        index === INPUT
          ? input.decode(stored)
          : decodeOutput(lowered[index]!, stored, selected[step])
      pass.set(index, { stored, value })
      return value
    }
  }

  const iterator = body(createBuilder(scope, (plan) => pending.add(plan)))
  let next = iterator.next()

  while (!next.done) {
    const plan = next.value
    if (!(plan instanceof Plan)) {
      // Yielding a reference lands here too: it has a value only in a run.
      throw new Error(
        `Workflow [${name}] can only yield plans created by its builder`,
      )
    }

    const at = { scope, limit: steps.length, label: `${name}.${plan.name}` }
    plan.place(scope, at.limit)
    pending.delete(plan)
    const step = { ...plan.step, name: plan.name }
    assertStep(options, step, steps)
    lowered.push(lower(step, at, reading))
    steps.push(step)
    plans.push(plan)
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

  const program: WorkflowProgram = Object.freeze({
    kind: 'workflow',
    ...route(options),
    steps: lowered.map(({ step }) => step),
    result: compute(result, end, reading, output.encode),
    timeout: options.timeout,
    definition: describe({ ...options, kind: 'workflow', steps }),
  })

  // The lists hold the declaration itself, so they are filled once it exists.
  const workflows: (
    | ServedWorkflow<Name, Input, Output, PlanServices<Y>, Pool>
    | Y['served']['workflows'][number]
  )[] = []
  const tasks: Y['served']['tasks'][number][] = []
  const programs: Program[] = []
  const declaration = Object.freeze({
    ...declared,
    kind: 'workflow' as const,
    input,
    output,
    steps,
    program,
    workflows,
    tasks,
    programs,
  })

  const served = new Set<(typeof workflows)[number]>([declaration])
  const servedTasks = new Set<(typeof tasks)[number]>()
  for (const plan of plans) {
    for (const child of plan.served.workflows) served.add(child)
    for (const task of plan.served.tasks) servedTasks.add(task)
  }
  workflows.push(...served)
  tasks.push(...servedTasks)
  programs.push(...[...workflows, ...tasks].map(({ program }) => program))
  for (const list of [steps, workflows, tasks, programs]) Object.freeze(list)

  return declaration
}

const namePattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

// Names cross JSON, jsonb, schema libraries and user code, where handling of
// reserved keys such as `__proto__` is outside our control.
const reservedNames = new Set(['__proto__', 'constructor', 'prototype'])

/** What can be refused about a step from its declaration alone. */
function assertStep(
  { name: workflow, revision }: Route,
  step: Placed,
  placed: readonly Placed[],
) {
  const { name } = step
  if (!namePattern.test(name)) {
    throw new Error(`Invalid workflow node name: ${name}`)
  }
  if (name === 'input') {
    throw new Error('Workflow node name cannot be "input"')
  }
  if (reservedNames.has(name)) {
    throw new Error(`Workflow node name cannot be "${name}"`)
  }
  if (placed.some((other) => other.name === name)) {
    throw new Error(`Duplicate workflow node name: ${name}`)
  }

  if (step.kind === 'branch' || step.kind === 'parallel') {
    const [kind, leaves] =
      step.kind === 'branch'
        ? (['branch case', step.cases] as const)
        : (['parallel member', step.members] as const)
    for (const [key] of leaves) {
      if (reservedNames.has(key)) {
        throw new Error(`Workflow ${kind} key cannot be "${key}": ${name}`)
      }
    }
  }

  if (step.kind === 'mapTask' || step.kind === 'mapWorkflow') {
    const { concurrency } = step
    // The engine starts items while fewer than this many are in flight, and
    // reads as many of those waiting: a count, which a store can keep.
    if (
      concurrency !== undefined &&
      (!Number.isSafeInteger(concurrency) || concurrency < 1)
    ) {
      throw new Error('Map node concurrency must be a positive integer')
    }
  }

  // A versioned run is pinned to exact code, which an unversioned target
  // cannot provide: its name resolves to whatever is deployed.
  if (revision === undefined) return
  for (const { target } of stepTargets(step)) {
    if (target.revision !== undefined) continue
    throw new Error(
      `Workflow [${workflow}@${revision}] node [${name}] references unversioned ${target.kind} [${target.name}]: every task and child workflow of a versioned workflow must declare a revision`,
    )
  }
}

/** A task or child workflow as a step's program names it. */
const reference = (target: AnyTask | ServedWorkflow) => ({
  ...route(target),
  definition: target.program.definition,
})

/** A value computed at one position, encoded for whatever receives it. */
function compute<A, Stored>(
  value: Ref<A>,
  at: Position,
  reading: Reading,
  encode: (value: A) => Stored,
): Compute<Stored> {
  return (outputs, input, selected) =>
    encode(resolve(value, at, reading(outputs, input, selected)))
}

function decodeOutput(
  { step, decode }: Lowered<ProgramStep>,
  stored: unknown,
  selectedCase: string | undefined,
) {
  try {
    return decode(stored, selectedCase)
  } catch (cause) {
    throw new Error(`Invalid node output [${step.name}]`, { cause })
  }
}

function lower(
  step: Placed,
  at: Position,
  reading: Reading,
): Lowered<ProgramStep> {
  const { name } = step

  switch (step.kind) {
    case 'branch': {
      assertValue(step.select, at)
      const { leaves, decoders } = lowerLeaves(step.cases, at, reading)

      return {
        step: {
          name,
          kind: 'branch',
          select: compute(step.select, at, reading, (key) => key),
          cases: leaves,
        },
        // Cases may produce one type through different encodings, so the
        // selected case owns the stored one.
        decode(stored, selectedCase) {
          const decode =
            selectedCase !== undefined && Object.hasOwn(decoders, selectedCase)
              ? decoders[selectedCase]
              : undefined
          if (!decode) {
            throw new Error(
              `Missing selected branch case [${name}.${selectedCase}]`,
            )
          }
          return decode(stored)
        },
      }
    }
    case 'parallel': {
      const { leaves, decoders } = lowerLeaves(step.members, at, reading)

      return {
        step: { name, kind: 'parallel', members: leaves },
        decode(stored) {
          const outputs = record(stored)
          const members: Record<string, unknown> = Object.create(null)
          for (const key of Object.keys(decoders)) {
            members[key] = decoders[key]!(outputs[key])
          }
          return members
        },
      }
    }
    case 'mapTask':
    case 'mapWorkflow':
      return lowerMap(step, at, reading)
    default: {
      const { step: leaf, decode } = lowerLeaf(step, at, reading)
      return { step: { name, ...leaf }, decode }
    }
  }
}

/** Cases and members read what the step itself may read: nothing later. */
function lowerLeaves(leaves: Leaves, at: Position, reading: Reading) {
  // Null prototypes, so no key is mistaken for an inherited member.
  const lowered: Record<string, ProgramLeaf> = Object.create(null)
  const decoders: Record<string, Decode> = Object.create(null)

  for (const [key, leaf] of leaves) {
    const label = `${at.label}.${key}`
    const { step, decode } = lowerLeaf(leaf, { ...at, label }, reading)
    lowered[key] = step
    decoders[key] = decode
  }

  return { leaves: lowered, decoders }
}

function lowerLeaf(
  leaf: Leaf,
  at: Position,
  reading: Reading,
): Lowered<ProgramLeaf> {
  assertValue(leaf.input, at)

  switch (leaf.kind) {
    case 'activity': {
      // Types rule this out; untyped callers get a build error, not a run failure.
      if (typeof leaf.handler !== 'function') {
        throw new Error(`Missing activity handler [${at.label}]`)
      }

      const { retry, timeout } = leaf
      const input = boundary(leaf.schema.input, `activity input [${at.label}]`)
      const output = boundary(
        leaf.schema.output,
        `activity output [${at.label}]`,
      )

      return {
        step: {
          kind: 'activity',
          execute: execution(input, output, leaf.handler),
          input: compute(leaf.input, at, reading, input.encode),
          retry,
          timeout,
        },
        decode: output.decode,
      }
    }
    case 'task': {
      const { task, retry, timeout } = leaf

      return {
        step: {
          kind: 'task',
          task: reference(task),
          input: compute(leaf.input, at, reading, task.input.encode),
          retry,
          timeout,
        },
        decode: task.output.decode,
      }
    }
    case 'workflow': {
      const { workflow, cancellation } = leaf

      return {
        step: {
          kind: 'workflow',
          workflow: reference(workflow),
          input: compute(leaf.input, at, reading, workflow.input.encode),
          cancellation,
        },
        decode: workflow.output.decode,
      }
    }
  }
}

/**
 * The engine calls `items` once and `input` once per item, when it starts that
 * item; both read the outputs that existed before the map.
 */
function lowerMap(
  step: MapStep & { readonly name: string },
  at: Position,
  reading: Reading,
): Lowered<ProgramStep> {
  assertValue(step.items, at)
  if (typeof step.input !== 'function') {
    throw new Error(
      `[${at.label}] needs an input callback for its items, received ${typeof step.input}`,
    )
  }

  const one = boundary(step.item, `map item [${at.label}]`)
  // Encoded as one list, so a value that is no list is refused like any
  // other value its schema does not fit.
  const list = boundary(Schema.Array(step.item), `map items [${at.label}]`)
  const declared = step.kind === 'mapTask' ? step.task : step.workflow
  const target: Exclude<Target, { kind: 'activity' }> =
    step.kind === 'mapTask'
      ? {
          kind: 'task',
          task: reference(step.task),
          retry: step.retry,
          timeout: step.timeout,
        }
      : {
          kind: 'workflow',
          workflow: reference(step.workflow),
          cancellation: step.cancellation,
        }

  return {
    step: {
      name: step.name,
      kind: 'map',
      items: compute(
        step.items,
        at,
        reading,
        // A list schema encodes to a list.
        (items) => list.encode(items) as readonly unknown[],
      ),
      input: (outputs, input, item, index, selected) =>
        declared.input.encode(
          resolve(
            step.input(one.decode(item), index),
            at,
            reading(outputs, input, selected),
          ),
        ),
      target,
      concurrency: step.concurrency,
    },
    decode(stored) {
      const { items } = record(stored)
      if (!Array.isArray(items)) throw new TypeError('Expected items array')

      return {
        items: items.map((entry: unknown) => {
          const { item, index, runId, output } = record(entry)
          if (typeof index !== 'number') {
            throw new TypeError('Expected a numeric item index')
          }
          if (typeof runId !== 'string') {
            throw new TypeError('Expected an item run id')
          }
          return {
            item: one.decode(item),
            index,
            runId,
            output: declared.output.decode(output),
          }
        }),
      }
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an object')
  }
  return value as Record<string, unknown>
}
