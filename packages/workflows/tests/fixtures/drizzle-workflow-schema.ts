import { createSchema } from '../../src/adapters/postgres/drizzle.ts'

const workflows = createSchema()

export const WorkflowAttemptTable = workflows.tables.attempts
export const WorkflowCommandTable = workflows.tables.commands
export const WorkflowNodeChildTable = workflows.tables.nodeChildren
export const WorkflowNodeTable = workflows.tables.nodes
export const WorkflowRunLeaseTable = workflows.tables.runLeases
export const WorkflowRunTable = workflows.tables.runs
export const WorkflowScheduleTable = workflows.tables.schedules
export const WorkflowSchemaVersionTable = workflows.tables.schemaVersion

export const WorkflowAttemptStatus = workflows.enums.attemptStatus
export const WorkflowCommandKind = workflows.enums.commandKind
export const WorkflowNodeChildKind = workflows.enums.nodeChildKind
export const WorkflowNodeKind = workflows.enums.nodeKind
export const WorkflowNodeStatus = workflows.enums.nodeStatus
export const WorkflowRunKind = workflows.enums.runKind
export const WorkflowRunStatus = workflows.enums.runStatus
