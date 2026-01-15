export enum StoreType {
  Redis = 'Redis',
  Valkey = 'Valkey',
}

export enum JobWorkerPool {
  Io = 'Io',
  Compute = 'Compute',
}

export enum LifecycleHook {
  BeforeInitialize = 'lifecycle:beforeInitialize',
  AfterInitialize = 'lifecycle:afterInitialize',
  BeforeDispose = 'lifecycle:beforeDispose',
  AfterDispose = 'lifecycle:afterDispose',
  Stop = 'lifecycle:stop',
  Start = 'lifecycle:start',
}

export enum WorkerType {
  Application = 'Application',
  Job = 'Job',
  Command = 'Command',
}
