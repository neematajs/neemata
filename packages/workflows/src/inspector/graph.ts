// Browser-safe: this module and what it imports must stay free of Node APIs,
// so a frontend can render saved graphs without bundling the runtime.
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseDefinition,
  BranchCaseKind,
  RunKind,
  RunnableDefinition,
  RunnableRevision,
  WorkflowNodeKind,
} from '../types/index.ts'

/** JSON shape of a workflow definition's topology and labels, as deployed now. */
export type WorkflowGraph = {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly nodes: readonly WorkflowGraphNode[]
}

export type WorkflowGraphNode = {
  readonly name: string
  readonly kind: WorkflowNodeKind
  readonly title?: string
  readonly description?: string
  /** Referenced task/workflow for task, workflow, mapTask and mapWorkflow nodes. */
  readonly target?: WorkflowGraphTarget
  /** Branch and parallel members, in definition order. */
  readonly cases?: readonly WorkflowGraphCase[]
}

export type WorkflowGraphTarget = {
  readonly kind: 'task' | 'workflow'
  readonly name: string
  readonly title?: string
  readonly description?: string
}

export type WorkflowGraphCase = {
  readonly key: string
  readonly kind: BranchCaseKind
  readonly title?: string
  readonly description?: string
  /** Absent for inline activity cases — they have no named target. */
  readonly target?: WorkflowGraphTarget
}

export type GraphLabels = {
  readonly title?: string
  readonly description?: string
}

export function labels({ title, description }: GraphLabels): GraphLabels {
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  }
}

function serializeTarget(
  kind: WorkflowGraphTarget['kind'],
  target: AnyTaskDefinition | AnyWorkflowDefinition,
): WorkflowGraphTarget {
  return { kind, name: target.name, ...labels(target) }
}

export function serializeWorkflowGraph(
  definition: AnyWorkflowDefinition,
): WorkflowGraph {
  const base = { name: definition.name, ...labels(definition) }
  const nodes = definition.nodes.map((node): WorkflowGraphNode => {
    const base = { name: node.name, kind: node.kind, ...labels(node) }

    switch (node.kind) {
      case 'activity':
        return base
      case 'task':
      case 'mapTask': {
        const target = serializeTarget('task', node.task)
        return { ...base, target }
      }
      case 'workflow':
      case 'mapWorkflow': {
        const target = serializeTarget('workflow', node.workflow)
        return { ...base, target }
      }
      case 'branch':
      case 'parallel': {
        const cases: WorkflowGraphCase[] = []

        for (const key in node.cases) {
          const branchCase = node.cases[key]
          const graphCase = {
            key,
            kind: branchCase.kind,
            ...labels(branchCase),
          }
          if (branchCase.kind === 'activity') {
            cases.push(graphCase)
            continue
          }

          // BranchCaseDefinition's conditional payload doesn't narrow on
          // `kind` at the union default, so the cast lives here once.
          const reference = branchCase as BranchCaseDefinition<
            'task' | 'workflow'
          >
          const target = serializeTarget(reference.kind, reference.target)
          cases.push({ ...graphCase, target })
        }

        return { ...base, cases }
      }
    }
  })

  return { ...base, nodes }
}

/**
 * Bumped whenever a structural field is added or its meaning changes, so a
 * hash never silently covers a different projection.
 */
export const STRUCTURE_FORMAT_VERSION = 1

export type StructuralTarget = {
  readonly kind: 'task' | 'workflow'
  readonly name: string
}

export type StructuralCase = {
  readonly key: string
  readonly kind: BranchCaseKind
  readonly target?: StructuralTarget
}

export type StructuralNode = {
  readonly name: string
  readonly kind: WorkflowNodeKind
  readonly target?: StructuralTarget
  /** Branch and parallel members, in definition order. */
  readonly cases?: readonly StructuralCase[]
}

export type WorkflowStructure = {
  readonly formatVersion: typeof STRUCTURE_FORMAT_VERSION
  readonly kind: 'workflow'
  readonly name: string
  /** In definition order, which is execution order. */
  readonly nodes: readonly StructuralNode[]
}

export type TaskStructure = {
  readonly formatVersion: typeof STRUCTURE_FORMAT_VERSION
  readonly kind: 'task'
  readonly name: string
}

/**
 * What a graph hash covers: names, kinds and the order of nodes and cases.
 * Labels, revisions, policies, schemas and handlers are deliberately absent, so
 * the hash identifies topology and says nothing about behavior.
 */
export type DefinitionStructure = WorkflowStructure | TaskStructure

export type StoredGraph = {
  readonly graphHash: string
  readonly structure: DefinitionStructure
}

/** The exact revision one named target slot of a workflow runs. */
export type RevisionBinding = {
  readonly nodeName: string
  /** Set for branch cases and parallel members; absent for a node's own target. */
  readonly caseKey?: string
  readonly target: RunnableRevision
}

/**
 * Immutable record of one revision: its graph and the revision of every task
 * and child workflow it references. A child's revision is part of its parent's
 * manifest, not of the parent's graph hash.
 */
export type RevisionManifest = RunnableRevision & {
  readonly graphHash: string
  /** In node order, then case order. Empty for tasks. */
  readonly bindings: readonly RevisionBinding[]
}

export type DefinitionBundle = {
  readonly graphs: readonly StoredGraph[]
  readonly revisions: readonly RevisionManifest[]
}

export type GraphCaseLabels = GraphLabels & { readonly target?: GraphLabels }

export type GraphNodeLabels = GraphLabels & {
  readonly target?: GraphLabels
  readonly cases?: Readonly<Record<string, GraphCaseLabels>>
}

/**
 * The labels one run was created with, keyed by node name and case key. Kept
 * per run and outside the graph hash, so relabelling a definition changes
 * neither the hash nor what older runs display.
 */
export type GraphPresentation = GraphLabels & {
  readonly nodes?: Readonly<Record<string, GraphNodeLabels>>
}

function structureOfTarget({ kind, name }: StructuralTarget): StructuralTarget {
  return { kind, name }
}

export function projectStructure(
  definition: RunnableDefinition,
): DefinitionStructure {
  const formatVersion = STRUCTURE_FORMAT_VERSION
  if (definition.kind === 'task') {
    return { formatVersion, kind: 'task', name: definition.name }
  }

  const graph = serializeWorkflowGraph(definition)
  const nodes = graph.nodes.map((node): StructuralNode => {
    const { name, kind } = node
    const target = node.target && structureOfTarget(node.target)
    const cases = node.cases?.map((member): StructuralCase => {
      const { key, kind } = member
      const target = member.target && structureOfTarget(member.target)
      return { key, kind, ...(target === undefined ? {} : { target }) }
    })

    return {
      name,
      kind,
      ...(target === undefined ? {} : { target }),
      ...(cases === undefined ? {} : { cases }),
    }
  })

  return { formatVersion, kind: 'workflow', name: graph.name, nodes }
}

function isEmpty(value: object) {
  return Object.keys(value).length === 0
}

/** Undefined when the definition declares no labels at all. */
export function captureGraphPresentation(
  definition: RunnableDefinition,
): GraphPresentation | undefined {
  if (definition.kind === 'task') {
    const own = labels(definition)
    return isEmpty(own) ? undefined : own
  }

  const graph = serializeWorkflowGraph(definition)
  const nodes: Record<string, GraphNodeLabels> = {}

  for (const node of graph.nodes) {
    const target = node.target && labels(node.target)
    const cases: Record<string, GraphCaseLabels> = {}

    for (const member of node.cases ?? []) {
      const target = member.target && labels(member.target)
      const entry = {
        ...labels(member),
        ...(target === undefined || isEmpty(target) ? {} : { target }),
      }
      if (!isEmpty(entry)) cases[member.key] = entry
    }

    const entry = {
      ...labels(node),
      ...(target === undefined || isEmpty(target) ? {} : { target }),
      ...(isEmpty(cases) ? {} : { cases }),
    }
    if (!isEmpty(entry)) nodes[node.name] = entry
  }

  const presentation = {
    ...labels(graph),
    ...(isEmpty(nodes) ? {} : { nodes }),
  }
  return isEmpty(presentation) ? undefined : presentation
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string) {
  return record !== undefined && Object.hasOwn(record, key)
    ? record[key]
    : undefined
}

/**
 * A saved workflow structure in the catalog's graph shape, labelled with the
 * presentation saved for the same run. Without one the graph carries names
 * only: labels are never taken from the definition deployed today.
 */
export function renderWorkflowGraph(
  structure: WorkflowStructure,
  presentation?: GraphPresentation,
): WorkflowGraph {
  const nodes = structure.nodes.map((node): WorkflowGraphNode => {
    const { name, kind } = node
    const saved = own(presentation?.nodes, name)
    const target = node.target && { ...node.target, ...saved?.target }
    const cases = node.cases?.map((member): WorkflowGraphCase => {
      const { key, kind } = member
      const savedCase = own(saved?.cases, key)
      const target = member.target && { ...member.target, ...savedCase?.target }

      return {
        key,
        kind,
        ...labels(savedCase ?? {}),
        ...(target === undefined ? {} : { target }),
      }
    })

    return {
      name,
      kind,
      ...labels(saved ?? {}),
      ...(target === undefined ? {} : { target }),
      ...(cases === undefined ? {} : { cases }),
    }
  })

  return { name: structure.name, ...labels(presentation ?? {}), nodes }
}

/**
 * Deterministic JSON text: object keys in code-unit order, arrays in the order
 * given, strings untouched (no Unicode normalization). Rejects anything JSON
 * would drop or coerce, so equal text always means equal data.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON cannot encode a non-finite number')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const items: string[] = []
    // Indexed, so a hole is reported instead of being skipped by iteration.
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError('Canonical JSON cannot encode a sparse array')
      }
      items.push(canonicalJson(value[index]))
    }
    return `[${items.join(',')}]`
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON can only encode plain objects')
    }
    const record = value as Record<string, unknown>
    // The default sort compares UTF-16 code units, independent of locale.
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${members.join(',')}}`
  }
  throw new TypeError(`Canonical JSON cannot encode a ${typeof value}`)
}

const nodeKinds: ReadonlySet<string> = new Set<WorkflowNodeKind>([
  'activity',
  'task',
  'workflow',
  'branch',
  'parallel',
  'mapTask',
  'mapWorkflow',
])

const targetKinds: Partial<Record<WorkflowNodeKind, RunKind>> = {
  task: 'task',
  mapTask: 'task',
  workflow: 'workflow',
  mapWorkflow: 'workflow',
}

function invalid(detail: string): never {
  throw new TypeError(`Invalid definition structure: ${detail}`)
}

function parseRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} is not an object`)
  }
  const record = value as Record<string, unknown>
  for (const key of required) {
    if (!Object.hasOwn(record, key)) invalid(`${label} lacks [${key}]`)
  }
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      invalid(`${label} has unknown field [${key}]`)
    }
  }
  return record
}

function parseName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    invalid(`${label} is not a non-empty string`)
  }
  return value
}

function parseList(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${label} is not an array`)
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid(`${label} is sparse`)
  }
  return value
}

function parseTarget(
  value: unknown,
  label: string,
  kind: RunKind,
): StructuralTarget {
  const record = parseRecord(value, label, ['kind', 'name'])
  if (record.kind !== kind) invalid(`${label} is not a ${kind}`)
  return { kind, name: parseName(record.name, `${label} name`) }
}

function parseCase(value: unknown, label: string): StructuralCase {
  const record = parseRecord(value, label, ['key', 'kind'], ['target'])
  const key = parseName(record.key, `${label} key`)
  const { kind } = record
  if (kind === 'activity') {
    if (record.target !== undefined) invalid(`${label} activity has a target`)
    return { key, kind }
  }
  if (kind !== 'task' && kind !== 'workflow') {
    invalid(`${label} has unknown kind [${String(kind)}]`)
  }
  return {
    key,
    kind,
    target: parseTarget(record.target, `${label} target`, kind),
  }
}

function parseNode(value: unknown, label: string): StructuralNode {
  const record = parseRecord(
    value,
    label,
    ['name', 'kind'],
    ['target', 'cases'],
  )
  const name = parseName(record.name, `${label} name`)
  if (typeof record.kind !== 'string' || !nodeKinds.has(record.kind)) {
    invalid(`${label} has unknown kind [${String(record.kind)}]`)
  }
  const kind = record.kind as WorkflowNodeKind
  const targetKind = targetKinds[kind]
  const hasCases = kind === 'branch' || kind === 'parallel'

  if (targetKind === undefined && record.target !== undefined) {
    invalid(`${label} ${kind} has a target`)
  }
  if (!hasCases && record.cases !== undefined) {
    invalid(`${label} ${kind} has cases`)
  }
  if (targetKind !== undefined) {
    const target = parseTarget(record.target, `${label} target`, targetKind)
    return { name, kind, target }
  }
  if (!hasCases) return { name, kind }

  const keys = new Set<string>()
  const cases = parseList(record.cases, `${label} cases`).map((item, index) => {
    const member = parseCase(item, `${label} case ${index}`)
    if (keys.has(member.key)) invalid(`${label} repeats case [${member.key}]`)
    keys.add(member.key)
    return member
  })
  return { name, kind, cases }
}

/**
 * Validates untrusted data as a structure and returns a fresh projection of
 * its known fields. Nothing is coerced or dropped: a value that is not exactly
 * a structure of the current format is rejected.
 */
export function parseStructure(value: unknown): DefinitionStructure {
  const record = parseRecord(
    value,
    'structure',
    ['formatVersion', 'kind', 'name'],
    ['nodes'],
  )
  const formatVersion = STRUCTURE_FORMAT_VERSION
  if (record.formatVersion !== formatVersion) {
    invalid(`unsupported format version [${String(record.formatVersion)}]`)
  }
  const name = parseName(record.name, 'structure name')

  if (record.kind === 'task') {
    if (record.nodes !== undefined) invalid('task structure has nodes')
    return { formatVersion, kind: 'task', name }
  }
  if (record.kind !== 'workflow') {
    invalid(`unknown kind [${String(record.kind)}]`)
  }

  const names = new Set<string>()
  const nodes = parseList(record.nodes, 'structure nodes').map(
    (item, index) => {
      const node = parseNode(item, `node ${index}`)
      if (names.has(node.name)) invalid(`repeated node [${node.name}]`)
      names.add(node.name)
      return node
    },
  )
  return { formatVersion, kind: 'workflow', name, nodes }
}

export type StructuralSlot = {
  readonly nodeName: string
  readonly caseKey?: string
  readonly target: StructuralTarget
}

/** The named-target slots of a structure, in node order, then case order. */
export function structureSlots(
  structure: DefinitionStructure,
): readonly StructuralSlot[] {
  if (structure.kind === 'task') return []

  const slots: StructuralSlot[] = []
  for (const node of structure.nodes) {
    if (node.target) slots.push({ nodeName: node.name, target: node.target })
    for (const member of node.cases ?? []) {
      if (!member.target) continue
      const { key: caseKey, target } = member
      slots.push({ nodeName: node.name, caseKey, target })
    }
  }
  return slots
}
