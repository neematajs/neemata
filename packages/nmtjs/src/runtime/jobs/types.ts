// ============================================================================
// Job Definition Types (metadata about job structure)
// ============================================================================

/** Metadata about a job step in a job definition */
export interface JobStepInfo {
  /** Optional human-readable label for the step */
  label?: string
  /** Whether this step has a condition that may skip it */
  conditional: boolean
}

/** Metadata about a job definition (not a running job instance) */
export interface JobDefinitionInfo {
  /** Job name from definition */
  name: string
  /** Information about each step in the job */
  steps: JobStepInfo[]
}

// ============================================================================
// Job Execution Types (runtime state of a running job)
// ============================================================================

/** Result of a single step execution */
export interface StepResultEntry {
  /** Output data produced by the step, or null if skipped */
  data: Record<string, unknown> | null
  /** Duration in milliseconds */
  duration: number
}

/** Checkpoint data persisted for job resume support */
export interface JobProgressCheckpoint {
  /** Index of the next step to execute (0 = not started, length = completed) */
  stepIndex: number
  /** Label of the last completed step */
  stepLabel?: string
  /** Accumulated result from all completed steps */
  result: Record<string, unknown>
  /** Results of each individual step */
  stepResults: StepResultEntry[]
  /** User-defined progress state */
  progress: Record<string, unknown>
}

/** Information about the currently executing job, available via injectable */
export interface JobExecutionContext {
  /** Job definition name */
  name: string
  /** Queue job ID */
  id?: string
  /** Queue name */
  queue?: string
  /** Number of attempts made so far */
  attempts?: number
  /** Current step index being executed */
  stepIndex?: number
}

// ============================================================================
// Job Item Types (job instances from queue)
// ============================================================================

/** Vendor-agnostic job status */
export type JobStatus =
  | 'pending' // Queued, waiting to be picked up
  | 'active' // Currently executing
  | 'completed' // Successfully finished
  | 'failed' // Failed (may retry)
  | 'delayed' // Scheduled for future
  | 'cancelled' // Manually cancelled
  | 'unknown' // State cannot be determined

/** A job instance retrieved from the queue */
export interface JobItem<TInput = unknown, TOutput = unknown> {
  /** Unique job instance ID */
  id: string
  /** Job definition name */
  name: string
  /** Queue name this job belongs to */
  queue: string
  /** Input data passed to the job */
  data: TInput
  /** Output produced by the job (if completed) */
  output?: TOutput | null
  /** Current job status */
  status: JobStatus
  /** Job priority (lower = higher priority) */
  priority?: number
  /** Job progress checkpoint (includes step state and user progress) */
  progress?: JobProgressCheckpoint
  /** Number of execution attempts */
  attempts: number
  /** Timestamp when job started processing (ms) */
  startedAt?: number
  /** Timestamp when job completed (ms) */
  completedAt?: number
  /** Error message if job failed */
  error?: string
  /** Stack trace if job failed */
  stacktrace?: string[]
}

// ============================================================================
// Injectable Types
// ============================================================================

/** Function to manually trigger saving job progress state */
export type SaveJobProgress = () => Promise<void>
