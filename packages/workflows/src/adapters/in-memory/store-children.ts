import type { StoredNode, StoredNodeChild } from '../../runtime/state.ts'
import type { WorkflowStore } from '../../runtime/store.ts'
import type { State } from './state.ts'
import { toStoredError } from '../../runtime/errors.ts'
import { isTerminalNodeStatus } from '../../runtime/status.ts'
import {
  childKey,
  childRef,
  nodeChildren,
  nodeKey,
  sameOptionalValue,
  sameValue,
  sortedChildren,
} from './records.ts'
import { createChildAttempt } from './store-nodes.ts'
import { createRunWithState } from './store-runs.ts'

type ChildStore = Pick<
  WorkflowStore,
  | 'selectNodeCase'
  | 'ensureNodeChildren'
  | 'ensureChildRun'
  | 'ensureChildAttempt'
  | 'completeNodeChild'
  | 'failNodeChild'
  | 'waitNode'
  | 'loadNodeChildren'
>

export function createChildStore(state: State): ChildStore {
  const { now, runs, nodes, attempts, children, wake } = state

  return {
    async selectNodeCase({ runId, nodeName, caseKey }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node
      if (node.selectedCase === caseKey) return node
      if (node.selectedCase !== undefined) {
        throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
      }

      const updated: StoredNode = {
        ...node,
        selectedCase: caseKey,
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },

    async ensureNodeChildren(params) {
      const node = nodes.get(nodeKey(params.runId, params.nodeName))
      if (!node) {
        throw new Error(`Missing node [${params.runId}.${params.nodeName}]`)
      }

      const existing = nodeChildren(state, params.runId, params.nodeName)
      if (existing.length > 0) {
        const matches =
          existing.length === params.children.length &&
          params.children.every((input) => {
            const child = children.get(
              childKey(params.runId, params.nodeName, input.childKey),
            )
            return (
              child !== undefined &&
              child.kind === input.kind &&
              child.ordinal === (input.ordinal ?? 0) &&
              child.itemKey === input.itemKey &&
              sameOptionalValue(child.item, input.item)
            )
          })
        if (!matches) {
          throw new Error(
            `Conflicting node children [${params.runId}.${params.nodeName}]`,
          )
        }
        return { children: sortedChildren(existing), created: false }
      }

      const date = now()
      const created: StoredNodeChild[] = []
      for (const input of params.children) {
        const child: StoredNodeChild = {
          runId: params.runId,
          nodeName: params.nodeName,
          childKey: input.childKey,
          kind: input.kind,
          status: 'pending',
          ordinal: input.ordinal ?? 0,
          ...(input.itemKey === undefined ? {} : { itemKey: input.itemKey }),
          ...(input.item === undefined ? {} : { item: input.item }),
          attemptCount: 0,
          version: 1,
          createdAt: date,
          updatedAt: date,
        }
        children.set(
          childKey(params.runId, params.nodeName, input.childKey),
          child,
        )
        created.push(child)
      }
      return { children: sortedChildren(created), created: true }
    },

    async ensureChildRun(params) {
      const key = childKey(params.runId, params.nodeName, params.childKey)
      const child = children.get(key)
      if (!child) {
        throw new Error(
          `Missing node child [${childRef(params.runId, params.nodeName, params.childKey)}]`,
        )
      }

      if (child.childRunId !== undefined) {
        const childRun = runs.get(child.childRunId)
        if (!childRun) {
          throw new Error(`Missing child run [${child.childRunId}]`)
        }
        if (
          childRun.kind !== params.childKind ||
          childRun.name !== params.childName ||
          !sameValue(childRun.input, params.input) ||
          !sameOptionalValue(childRun.idempotencyKey, params.idempotencyKey)
        ) {
          throw new Error(
            `Conflicting child run [${childRef(params.runId, params.nodeName, params.childKey)}]`,
          )
        }
        if (child.status === 'pending') {
          children.set(key, {
            ...child,
            status: 'running',
            version: child.version + 1,
            updatedAt: now(),
          })
        }
        return { child: children.get(key)!, childRun, created: false }
      }

      if (isTerminalNodeStatus(child.status)) {
        throw new Error(
          `Terminal node child [${childRef(params.runId, params.nodeName, params.childKey)}] cannot start child run`,
        )
      }

      const childRun = createRunWithState(state, {
        kind: params.childKind,
        name: params.childName,
        workflowName: params.childName,
        ...(params.childKind === 'task' ? { taskName: params.childName } : {}),
        input: params.input,
        parentRunId: params.runId,
        parentNodeName: params.nodeName,
        rootRunId: params.rootRunId,
        ...(params.tags === undefined ? {} : { tags: params.tags }),
        ...(params.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: params.idempotencyKey }),
      }).run
      const linked: StoredNodeChild = {
        ...child,
        childRunId: childRun.id,
        status: 'running',
        version: child.version + 1,
        updatedAt: now(),
      }
      children.set(key, linked)
      wake.statusChange(child, linked)
      return { child: linked, childRun, created: true }
    },

    async ensureChildAttempt(params) {
      const child = children.get(
        childKey(params.runId, params.nodeName, params.childKey),
      )
      if (!child) {
        throw new Error(
          `Missing node child [${childRef(params.runId, params.nodeName, params.childKey)}]`,
        )
      }

      if (child.attemptCount > 0) {
        let current =
          child.currentAttemptId === undefined
            ? undefined
            : attempts.get(child.currentAttemptId)
        if (current === undefined) {
          for (const attempt of attempts.values()) {
            if (
              attempt.runId !== child.runId ||
              attempt.nodeName !== child.nodeName ||
              attempt.childKey !== child.childKey
            ) {
              continue
            }
            if (
              current === undefined ||
              attempt.attemptNumber > current.attemptNumber
            ) {
              current = attempt
            }
          }
        }
        if (!current) {
          throw new Error(
            `Missing node child attempt [${childRef(params.runId, params.nodeName, params.childKey)}]`,
          )
        }
        if (
          child.status === 'pending' &&
          child.currentAttemptId === undefined
        ) {
          return {
            attempt: createChildAttempt(
              state,
              child,
              current.input,
              current.idempotencyKey,
            ),
            created: true,
          }
        }
        return { attempt: current, created: false }
      }
      if (isTerminalNodeStatus(child.status)) {
        throw new Error(
          `Terminal node child [${childRef(params.runId, params.nodeName, params.childKey)}] cannot create attempt`,
        )
      }

      const attempt = createChildAttempt(
        state,
        child,
        params.input,
        params.idempotencyKey,
      )
      return { attempt, created: true }
    },

    async completeNodeChild({ runId, nodeName, childKey: key, output }) {
      const mapKey = childKey(runId, nodeName, key)
      const child = children.get(mapKey)
      if (!child) return undefined
      if (isTerminalNodeStatus(child.status)) return child

      const updated: StoredNodeChild = {
        ...child,
        status: 'completed',
        output,
        version: child.version + 1,
        updatedAt: now(),
      }
      children.set(mapKey, updated)
      wake.statusChange(child, updated)
      return updated
    },

    async failNodeChild({ runId, nodeName, childKey: key, error }) {
      const mapKey = childKey(runId, nodeName, key)
      const child = children.get(mapKey)
      if (!child) return undefined
      if (isTerminalNodeStatus(child.status)) return child

      const updated: StoredNodeChild = {
        ...child,
        status: 'failed',
        error: toStoredError(error),
        version: child.version + 1,
        updatedAt: now(),
      }
      children.set(mapKey, updated)
      wake.statusChange(child, updated)
      return updated
    },

    async waitNode({ runId, nodeName }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node
      if (node.status === 'waiting') return node

      const updated: StoredNode = {
        ...node,
        status: 'waiting',
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      wake.statusChange(node, updated)
      return updated
    },

    async loadNodeChildren({ runId, nodeName }) {
      return {
        children: sortedChildren(nodeChildren(state, runId, nodeName)),
        attempts: [...attempts.values()].filter(
          (attempt) => attempt.runId === runId && attempt.nodeName === nodeName,
        ),
      }
    },
  }
}
