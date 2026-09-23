import type {
  ActivityAttemptCommand,
  ContinueRunCommand,
  TaskAttemptCommand,
} from '../../runtime/commands.ts'
import type { DeadWorkflowCommand, WorkflowStore } from '../../runtime/store.ts'
import type { QueueItem } from './commands.ts'
import type { State } from './state.ts'
import { requeueDeadContinue } from './queue.ts'

function mapDeadCommand(
  item: QueueItem<
    ContinueRunCommand | ActivityAttemptCommand | TaskAttemptCommand
  >,
  kind: DeadWorkflowCommand['kind'],
): DeadWorkflowCommand | undefined {
  if (item.deadAt === undefined) return undefined
  const payload = item.payload
  return {
    id: item.id,
    kind,
    runId: payload.runId,
    workflowName: payload.workflowName,
    ...('taskName' in payload ? { taskName: payload.taskName } : {}),
    ...('activityName' in payload
      ? { activityName: payload.activityName }
      : {}),
    ...('nodeName' in payload ? { nodeName: payload.nodeName } : {}),
    ...('attemptId' in payload ? { attemptId: payload.attemptId } : {}),
    payload,
    deliveryCount: item.deliveryCount,
    ...(item.lastError === undefined ? {} : { lastError: item.lastError }),
    deadAt: item.deadAt,
    createdAt: item.createdAt,
  }
}

function requeueDead<T>(queue: QueueItem<T>[], commandId: string) {
  const index = queue.findIndex(
    (item) => item.id === commandId && item.deadAt !== undefined,
  )
  if (index === -1) return false
  const item = queue[index]!
  queue[index] = {
    id: item.id,
    payload: item.payload,
    deliveryCount: 0,
    createdAt: item.createdAt,
  }
  return true
}

type CommandStore = Pick<
  WorkflowStore,
  | 'listDeadCommands'
  | 'listUnreapedDeadCommands'
  | 'markDeadCommandReaped'
  | 'requeueDeadCommand'
>

export function createCommandStore(state: State): CommandStore {
  const { now, continueRunCommands, attemptCommands } = state

  return {
    async listDeadCommands(params) {
      return [
        ...continueRunCommands.flatMap((item) => {
          const dead = mapDeadCommand(item, 'continue')
          return dead === undefined ? [] : [dead]
        }),
        ...attemptCommands.flatMap((item) => {
          const dead = mapDeadCommand(
            item,
            item.payload.kind === 'activityAttempt' ? 'activity' : 'task',
          )
          return dead === undefined ? [] : [dead]
        }),
      ]
        .filter(
          (command) =>
            params?.runId === undefined || command.runId === params.runId,
        )
        .sort((left, right) => {
          const byDeadAt = right.deadAt.getTime() - left.deadAt.getTime()
          if (byDeadAt !== 0) return byDeadAt
          const byCreatedAt =
            right.createdAt.getTime() - left.createdAt.getTime()
          if (byCreatedAt !== 0) return byCreatedAt
          return left.id.localeCompare(right.id)
        })
    },

    async listUnreapedDeadCommands(params) {
      const limit = params?.limit ?? Number.POSITIVE_INFINITY
      const dead: DeadWorkflowCommand[] = []
      for (const item of continueRunCommands) {
        if (
          item.deadAt === undefined ||
          item.reapedAt !== undefined ||
          (params?.commandId !== undefined && item.id !== params.commandId)
        ) {
          continue
        }
        const command = mapDeadCommand(item, 'continue')
        if (command !== undefined) dead.push(command)
      }
      for (const item of attemptCommands) {
        if (item.deadAt === undefined || item.reapedAt !== undefined) continue
        const command = mapDeadCommand(
          item,
          item.payload.kind === 'activityAttempt' ? 'activity' : 'task',
        )
        if (command !== undefined) dead.push(command)
      }
      return dead
        .sort((left, right) => left.deadAt.getTime() - right.deadAt.getTime())
        .slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
    },

    async markDeadCommandReaped(commandId) {
      function mark<T>(queue: QueueItem<T>[]) {
        const index = queue.findIndex(
          (item) =>
            item.id === commandId &&
            item.deadAt !== undefined &&
            item.reapedAt === undefined,
        )
        if (index === -1) return false
        queue[index] = { ...queue[index]!, reapedAt: now() }
        return true
      }
      if (mark(continueRunCommands)) return
      mark(attemptCommands)
    },

    async requeueDeadCommand(commandId) {
      if (requeueDeadContinue(state, commandId)) return
      requeueDead(attemptCommands, commandId)
    },
  }
}
