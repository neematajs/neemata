// import type { ApplicationWorker } from '@nmtjs/runtime/worker'
// import { typeToString } from '@nmtjs/type'
// import { defineCommand } from 'citty'

// export default (worker: ApplicationWorker) =>
//   defineCommand({
//     meta: { description: 'Application CLI' },
//     subCommands: {
//       list: defineCommand({
//         async run(ctx) {
//           worker.app.initializeCore()
//           const commands = Array.from(worker.app.registry.commands).map(
//             ([name, command]) => ({
//               command: name,
//               args: typeToString(command.args),
//               kwargs: typeToString(command.kwargs),
//             }),
//           )
//           console.table(commands, ['command', 'args', 'kwargs'])
//         },
//       }),
//       execute: defineCommand({
//         async run(ctx) {
//           const { _: positionals, ...kwargs } = ctx.args
//           const [commandName, ...args] = positionals
//           await worker.runCommand(commandName, args, kwargs)
//         },
//       }),
//     },
//   })
