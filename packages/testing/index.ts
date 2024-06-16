// import type {
//   Application,
//   BaseTaskRunner,
//   Provider,
// } from '@neematajs/application'
// import { BaseClient, type AppClientInterface } from '@neematajs/common'

// export class TestApplication {
//   constructor(
//     protected readonly userApplication: Application,
//     protected readonly defaultTimeout: number,
//   ) {
//     if (userApplication.options.tasks) {
//       // override task runner, to execute tasks on a single thread
//       userApplication.options.tasks.runner = undefined
//     }
//   }

//   overrideProvider<T extends Provider>(provider: T, value: T['value']) {
//     this.userApplication.container.provide(provider, value)
//     return this
//   }

//   overrideTask(
//     runner: BaseTaskRunner | undefined,
//     timeout: number = this.defaultTimeout,
//   ) {
//     this.userApplication.options.tasks = {
//       ...this.userApplication.options.tasks,
//       timeout,
//       runner,
//     }
//   }
// }

// export const createTestApplication = (
//   application: Application,
//   defaultTimeout = 15000,
// ) => new TestApplication(application, defaultTimeout)

// export class TestClient<AppClient extends AppClientInterface = any> extends BaseClient<AppClient> {

// }

// export const createTestClient = () => {}
