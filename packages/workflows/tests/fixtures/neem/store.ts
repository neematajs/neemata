import { InMemory } from '@nmtjs/workflows'

/** A store of its own for every thread: threads share no run. */
export const store = InMemory.layer()
