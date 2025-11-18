export enum JobWorkerQueue {
  Io = 'Io',
  Compute = 'Compute',
}

export enum LifecycleHook {
  RuntimeInitializeBefore = 'runtime:initialize:before',
  RuntimeInitializeAfter = 'runtime:initialize:after',
  RuntimeStartBefore = 'runtime:start:before',
  RuntimeStartAfter = 'runtime:start:after',
  RuntimeStopBefore = 'runtime:stop:before',
  RuntimeStopAfter = 'runtime:stop:after',
  RuntimeDisposeBefore = 'runtime:terminate:before',
  RuntimeDisposeAfter = 'runtime:terminate:after',

  RuntimePluginInitializeBefore = 'runtime:plugin:initialze:before',
  RuntimePluginInitializeAfter = 'runtime:plugin:initialze:after',
  RuntimePluginDisposeBefore = 'runtime:plugin:dispose:before',
  RuntimePluginDisposeAfter = 'runtime:plugin:dispose:after',

  RuntimeTransportInitializeBefore = 'runtime:transport:initialize:before',
  RuntimeTransportInitializeAfter = 'runtime:transport:initialize:after',

  RuntimeContainerInitializeBefore = 'runtime:container:initialze:before',
  RuntimeContainerInitializeAfter = 'runtime:container:initialze:after',

  RuntimeContainerDisposeBefore = 'runtime:container:dispose:before',
  RuntimeContainerDisposeAfter = 'runtime:container:dispose:after',

  AppInitializeBefore = 'app:initialize:before',
  AppInitializeAfter = 'app:initialize:after',

  AppDisposeBefore = 'app:terminate:before',
  AppDisposeAfter = 'app:terminate:after',

  AppPluginInitializeBefore = 'app:plugin:initialze:before',
  AppPluginInitializeAfter = 'app:plugin:initialze:after',
  AppPluginDisposeBefore = 'app:plugin:dispose:before',
  AppPluginDisposeAfter = 'app:plugin:dispose:after',

  AppContainerInitializeBefore = 'app:container:initialze:before',
  AppContainerInitializeAfter = 'app:container:initialze:after',

  AppContainerDisposeBefore = 'app:container:dispose:before',
  AppContainerDisposeAfter = 'app:container:dispose:after',
}
