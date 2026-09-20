import { createRuntime } from '@nmtjs/neem'

// The application owns its worker entry and transports; the preset supplies
// only a default single-worker plan. Neem still resolves conventional entries.
export const createEffectRuntime = createRuntime({
  planner: '@nmtjs/effect/neem/planner',
})
