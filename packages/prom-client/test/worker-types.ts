import { Registry, WorkerRegistry } from '../index.js'

// The host collector explicitly coordinates workers even outside the main thread.
new WorkerRegistry()
new WorkerRegistry(undefined, true)
new WorkerRegistry(Registry.OPENMETRICS_CONTENT_TYPE, false)

// @ts-expect-error The primary flag is a boolean, not a thread identifier.
new WorkerRegistry(undefined, 1)
