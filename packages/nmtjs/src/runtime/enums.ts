export enum StoreType {
  Redis = 'Redis',
  Valkey = 'Valkey',
}

export enum WorkerType {
  Application = 'Application',
  Job = 'Job',
  Command = 'Command',
}

export { LifecycleHook } from '@nmtjs/application'
