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
  Command = 'Command',
  Plugin = 'Plugin',
}
