export enum StoreType {
  Redis = 'Redis',
  Valkey = 'Valkey',
}

export enum JobWorkerQueue {
  Io = 'Io',
  Compute = 'Compute',
}

export enum LifecycleHook {
  BeforeInitialize = 'lifecycle:beforeInitialize',
  AfterInitialize = 'lifecycle:afterInitialize',
  BeforeDispose = 'lifecycle:beforeDispose',
  AfterDispose = 'lifecycle:afterDispose',
}
