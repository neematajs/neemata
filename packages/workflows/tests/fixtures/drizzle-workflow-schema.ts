import { createSchema } from '../../src/adapters/postgres/drizzle.ts'

const workflows = createSchema()

export const WorkflowAttemptTable = workflows.tables.attempts
export const WorkflowChildLinkTable = workflows.tables.childLinks
export const WorkflowCommandTable = workflows.tables.commands
export const WorkflowMapItemSetTable = workflows.tables.mapItemSets
export const WorkflowMapItemTable = workflows.tables.mapItems
export const WorkflowNodeTable = workflows.tables.nodes
export const WorkflowRunLeaseTable = workflows.tables.runLeases
export const WorkflowRunTable = workflows.tables.runs
export const WorkflowSchemaVersionTable = workflows.tables.schemaVersion

export const WorkflowAttemptStatus = workflows.enums.attemptStatus
export const WorkflowCommandKind = workflows.enums.commandKind
export const WorkflowNodeKind = workflows.enums.nodeKind
export const WorkflowNodeStatus = workflows.enums.nodeStatus
export const WorkflowRunKind = workflows.enums.runKind
export const WorkflowRunStatus = workflows.enums.runStatus
