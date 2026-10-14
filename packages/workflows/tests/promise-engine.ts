import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** What the pre-swap Promise engine described for one definition. */
export type Saved = {
  /** The canonical JSON of the structure: the bytes that were hashed. */
  readonly canonical: string
  readonly graphHash: string
  readonly structure: unknown
  readonly presentation?: unknown
  readonly manifest?: unknown
  /** `serializeWorkflowGraph` of a workflow. */
  readonly graph?: unknown
}

/**
 * What this branch's Promise engine, just before it was swapped for this one,
 * described and served for the same declarations as `fixtures/billing.ts`,
 * `fixtures/fulfillment.ts` and the labelled `declare('v1', ...)` of
 * `dsl-graph.spec.ts`, authored with its own DSL. That source carried the
 * branch's unreleased pinned-revision hashing, which no release stored
 * (`0.18.0-alpha.4` saved no definitions), so this is no record of published
 * data: it proves the two DSLs give the same graphs, byte for byte.
 */
export const PROMISE_ENGINE = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, 'fixtures/promise-engine.json'),
    'utf8',
  ),
) as {
  readonly billing: {
    readonly workflows: readonly Saved[]
    readonly tasks: readonly Saved[]
    /** `serializeWorkflowCatalog` of every billing declaration. */
    readonly catalog: unknown
  }
  readonly fulfillment: {
    readonly workflows: readonly Saved[]
    readonly tasks: readonly Saved[]
  }
  readonly labelled: Readonly<Record<'task' | 'child' | 'parent', Saved>>
}
