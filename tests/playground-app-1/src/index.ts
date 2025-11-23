import { HttpTransport } from 'nmtjs/http-transport/node'
import {
  createFilter,
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
} from 'nmtjs/runtime'
import { t } from 'nmtjs/type'

const testProcedure = createProcedure({
  input: t.any(),
  handler: (_, input) => input,
})

export default defineApplication({
  router: createRootRouter(createRouter({ routes: { test: testProcedure } })),
  transports: { http: HttpTransport },
  filters: [
    createFilter({
      errorClass: Error,
      catch: (_, error) => {
        console.log('Caught error in filter:', error.message)
        return error
      },
    }),
  ],
})
