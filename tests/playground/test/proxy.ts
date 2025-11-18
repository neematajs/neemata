// import { once } from 'node:events'
// import {
//   isMainThread,
//   parentPort,
//   Worker,
//   workerData,
// } from 'node:worker_threads'

// import { NeemataProxy } from '@nmtjs/proxy'

// if (isMainThread) {
//   const incr = 0
//   const workers = Array.from(
//     { length: Number(process.argv[2]) },
//     (_, i) => new Worker(new URL(import.meta.url), { workerData: { i } }),
//   )

//   const proxy = new NeemataProxy({

//   })

//   await proxy.run()
//   await Promise.all(workers.map((worker) => once(worker, 'online')))
//   await Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM')])
//   await proxy.shutdown()
//   process.exit(0)
// } else {
//   parentPort?.ref()
//   if (globalThis.Bun) {
//     Bun.serve({
//       port: 3030 + workerData.i,
//       hostname: '0.0.0.0',
//       fetch: async () => {
//         return new Response('Hello world!', {
//           status: 200,
//           headers: { 'Content-Type': 'text/plain' },
//         })
//       },
//     })
//   } else {
//     const { App } = await import('uWebSockets.js')
//     App({})
//       .any('*', (res) => {
//         res.cork(() => {
//           res.writeHeader('Content-Type', 'text/plain')
//           res.writeStatus('200 OK')
//           res.end('Hello world!')
//         })
//       })
//       .listen('127.0.0.1', 3030 + workerData.i, () => {
//         console.log(`Server is listening (PID ${process.pid})`)
//       })
//   }
// }
