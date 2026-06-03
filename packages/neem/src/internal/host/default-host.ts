import { defineRuntimeHost } from '../../public/runtime.ts'

export default defineRuntimeHost(() => {
  // Default host keeps one lightweight runner alive per runtime so lifecycle,
  // planner options, and cleanup follow same path as custom hosts.
  return {}
})
