import { n } from 'nmtjs'

import { downloadBlobProcedure } from './procedures/download-blob.ts'
import { pingProcedure } from './procedures/ping.ts'
import { streamBlobProcedure } from './procedures/stream-blob.ts'
import { streamCountProcedure } from './procedures/stream-count.ts'
import { uploadBlobProcedure } from './procedures/upload-blob.ts'

export const router = n.rootRouter([
  n.router({
    routes: {
      ping: pingProcedure,
      streamCount: streamCountProcedure,
      streamBlob: streamBlobProcedure,
      uploadBlob: uploadBlobProcedure,
      downloadBlob: downloadBlobProcedure,
    },
  }),
])
