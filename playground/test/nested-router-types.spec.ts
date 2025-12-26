/**
 * Test file for investigating ClientCallers type resolution with deeply nested routers
 */
import type {
  ClientCallers,
  ResolveContract,
  StaticInputContractTypeProvider,
  StaticOutputContractTypeProvider,
} from '@nmtjs/client'
import { c } from '@nmtjs/contract'
import { t } from '@nmtjs/type'
import { describe, expectTypeOf, it } from 'vitest'

// Level 1 - Simple flat router (should work)
const level1Contract = c.router({
  routes: { proc1: c.procedure({ input: t.string(), output: t.string() }) },
})

// Level 2 - One level of nesting
const level2Contract = c.router({
  routes: {
    nested: c.router({
      routes: { proc2: c.procedure({ input: t.string(), output: t.string() }) },
    }),
  },
})

// Level 3 - Two levels of nesting
const level3Contract = c.router({
  routes: {
    level1: c.router({
      routes: {
        level2: c.router({
          routes: {
            proc3: c.procedure({ input: t.string(), output: t.string() }),
          },
        }),
      },
    }),
  },
})

// Level 4 - Three levels of nesting
const level4Contract = c.router({
  routes: {
    a: c.router({
      routes: {
        b: c.router({
          routes: {
            c: c.router({
              routes: {
                proc4: c.procedure({ input: t.string(), output: t.string() }),
              },
            }),
          },
        }),
      },
    }),
  },
})

// Level 5 - Four levels of nesting
const level5Contract = c.router({
  routes: {
    a: c.router({
      routes: {
        b: c.router({
          routes: {
            c: c.router({
              routes: {
                d: c.router({
                  routes: {
                    proc5: c.procedure({
                      input: t.string(),
                      output: t.string(),
                    }),
                  },
                }),
              },
            }),
          },
        }),
      },
    }),
  },
})

// Level 6 - Five levels of nesting
const level6Contract = c.router({
  routes: {
    a: c.router({
      routes: {
        b: c.router({
          routes: {
            c: c.router({
              routes: {
                d: c.router({
                  routes: {
                    e: c.router({
                      routes: {
                        proc6: c.procedure({
                          input: t.string(),
                          output: t.string(),
                        }),
                      },
                    }),
                  },
                }),
              },
            }),
          },
        }),
      },
    }),
  },
})

// Level 7 - Six levels of nesting
const level7Contract = c.router({
  routes: {
    a: c.router({
      routes: {
        b: c.router({
          routes: {
            c: c.router({
              routes: {
                d: c.router({
                  routes: {
                    e: c.router({
                      routes: {
                        f: c.router({
                          routes: {
                            proc7: c.procedure({
                              input: t.string(),
                              output: t.string(),
                            }),
                          },
                        }),
                      },
                    }),
                  },
                }),
              },
            }),
          },
        }),
      },
    }),
  },
})

describe('ClientCallers type resolution with nested routers', () => {
  it('should resolve types for level 1 (flat) router', () => {
    type Resolved = ResolveContract<
      typeof level1Contract,
      StaticInputContractTypeProvider,
      StaticOutputContractTypeProvider
    >
    type Callers = ClientCallers<Resolved, false, false>

    // This should be a function
    type Proc1Type = Callers['proc1']
    expectTypeOf<Proc1Type>().toBeFunction()
  })

  it('should resolve types for level 2 (one nested) router', () => {
    type Resolved = ResolveContract<
      typeof level2Contract,
      StaticInputContractTypeProvider,
      StaticOutputContractTypeProvider
    >
    type Callers = ClientCallers<Resolved, false, false>

    // nested should be an object with proc2
    type NestedType = Callers['nested']
    type Proc2Type = NestedType['proc2']
    expectTypeOf<Proc2Type>().toBeFunction()
  })

  it('should resolve types for level 3 (two nested) router', () => {
    type Resolved = ResolveContract<
      typeof level3Contract,
      StaticInputContractTypeProvider,
      StaticOutputContractTypeProvider
    >
    type Callers = ClientCallers<Resolved, false, false>

    // level1.level2.proc3 should be a function
    type Level1Type = Callers['level1']
    type Level2Type = Level1Type['level2']
    type Proc3Type = Level2Type['proc3']
    expectTypeOf<Proc3Type>().toBeFunction()
  })

  it('should resolve types for level 4 (three nested) router', () => {
    type Resolved = ResolveContract<
      typeof level4Contract,
      StaticInputContractTypeProvider,
      StaticOutputContractTypeProvider
    >
    type Callers = ClientCallers<Resolved, false, false>

    // a.b.c.proc4 should be a function
    type AType = Callers['a']
    type BType = AType['b']
    type CType = BType['c']
    type Proc4Type = CType['proc4']
    expectTypeOf<Proc4Type>().toBeFunction()
  })

  it('should resolve types for level 5 (four nested) router', () => {
    type Resolved = ResolveContract<
      typeof level5Contract,
      StaticInputContractTypeProvider,
      StaticOutputContractTypeProvider
    >
    type Callers = ClientCallers<Resolved, false, false>

    // a.b.c.d.proc5 should be a function
    type AType = Callers['a']
    type BType = AType['b']
    type CType = BType['c']
    type DType = CType['d']
    type Proc5Type = DType['proc5']
    expectTypeOf<Proc5Type>().toBeFunction()
  })

  it('should resolve types for level 6 (five nested) router', () => {
    type Resolved = ResolveContract<
      typeof level6Contract,
      StaticInputContractTypeProvider,
      StaticOutputContractTypeProvider
    >
    type Callers = ClientCallers<Resolved, false, false>

    // a.b.c.d.e.proc6 should be a function
    type AType = Callers['a']
    type BType = AType['b']
    type CType = BType['c']
    type DType = CType['d']
    type EType = DType['e']
    type Proc6Type = EType['proc6']
    expectTypeOf<Proc6Type>().toBeFunction()
  })

  it('should resolve types for level 7 (six nested) router', () => {
    type Resolved = ResolveContract<
      typeof level7Contract,
      StaticInputContractTypeProvider,
      StaticOutputContractTypeProvider
    >
    type Callers = ClientCallers<Resolved, false, false>

    // a.b.c.d.e.f.proc7 should be a function
    type AType = Callers['a']
    type BType = AType['b']
    type CType = BType['c']
    type DType = CType['d']
    type EType = DType['e']
    type FType = EType['f']
    type Proc7Type = FType['proc7']
    expectTypeOf<Proc7Type>().toBeFunction()
  })
})
