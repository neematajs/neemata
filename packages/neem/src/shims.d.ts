declare module '#neem/runtime' {
  import type { NeemRuntimeDescriptor } from './runtime-module.ts'

  const runtime: NeemRuntimeDescriptor

  export default runtime
}
