export enum StoreType {
  Redis = 'Redis',
  Valkey = 'Valkey',
}

export enum JobWorkerPool {
  Io = 'Io',
  Compute = 'Compute',
}

export enum WorkerType {
  Application = 'Application',
  Job = 'Job',
  Command = 'Command',
}

export { LifecycleHook } from '@nmtjs/application'
