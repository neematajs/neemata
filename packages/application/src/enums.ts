export enum ApplicationWorkerType {
  Api = 'Api',
  Command = 'Command',
  Compute = 'Compute',
  Io = 'Io',
}

export enum ApplicationType {
  Api = 'Api',
  Command = 'Command',
  Job = 'Job',
}

export enum LifecycleHook {
  InitializeBefore = 'app:initialize:before',
  InitializeAfter = 'app:initialize:after',
  StartBefore = 'app:start:before',
  StartAfter = 'app:start:after',
  StopBefore = 'app:stop:before',
  StopAfter = 'app:stop:after',
  DisposeBefore = 'app:terminate:before',
  DisposeAfter = 'app:terminate:after',

  PluginInitializeBefore = 'app:plugin:initialze:before',
  PluginInitializeAfter = 'app:plugin:initialze:after',
  PluginDisposeBefore = 'app:plugin:dispose:before',
  PluginDisposeAfter = 'app:plugin:dispose:after',

  TransportInitializeBefore = 'app:transport:initialize:before',
  TransportInitializeAfter = 'app:transport:initialize:after',

  ContainerInitializeBefore = 'app:container:initialze:before',
  ContainerInitializeAfter = 'app:container:initialze:after',

  ContainerDisposeBefore = 'app:container:dispose:before',
  ContainerDisposeAfter = 'app:container:dispose:after',
}
