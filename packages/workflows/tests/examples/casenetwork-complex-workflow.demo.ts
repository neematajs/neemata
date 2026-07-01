import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../../src/index.ts'

const caseKindSchema = t.union(t.literal('outpatient'), t.literal('obstetrics'))

const usageSchema = t.object({
  totalCost: t.number(),
})

const reviewSchema = t.object({
  status: t.string(),
})

const caseGenerationInputSchema = t.object({
  curriculumId: t.string(),
  scenario: t.string(),
  kind: caseKindSchema,
  dreyfusLevels: t.array(t.string()),
})

const outpatientContentSchema = t.object({
  kind: t.literal('outpatient'),
  name: t.string(),
  description: t.string(),
  gender: t.string(),
  content: t.string(),
  review: reviewSchema,
  usage: usageSchema,
})

const obstetricsDataSchema = t.object({
  caseEntry: t.string(),
  maternalFetalAssessment: t.string(),
  interpretationAndPlan: t.string(),
  management: t.string(),
  reassessment: t.string(),
  deliveryPlanning: t.string(),
  postpartum: t.string(),
  outcomeReflection: t.string(),
})

const obstetricsContentSchema = t.object({
  kind: t.literal('obstetrics'),
  name: t.string(),
  description: t.string(),
  gender: t.string(),
  content: t.string(),
  obstetricsData: obstetricsDataSchema,
  review: reviewSchema,
  usage: usageSchema,
})

const questionGenerationOutputSchema = t.object({
  caseData: t.object({ kind: caseKindSchema, payload: t.any() }),
  generatedQuestions: t.array(t.object({ prompt: t.string() })),
  questionReview: reviewSchema,
  usage: usageSchema,
})

const curriculumSpecSchema = t.object({
  id: t.string(),
  domain: t.string(),
  title: t.string(),
  dreyfusLevels: t.array(t.string()),
})

const curriculumScenarioSchema = t.object({
  id: t.string(),
  domain: t.string(),
  title: t.string(),
  dreyfusLevels: t.array(t.string()),
  scenario: t.string(),
})

const sectionInputSchema = t.object({
  blueprint: t.string(),
})

const composeOutpatientContentInputSchema = t.object({
  patientBackground: t.string(),
  differentialDiagnosis: t.string(),
  labsAndDiagnostics: t.string(),
  treatmentPlan: t.string(),
  outcome: t.string(),
})

const composeObstetricsDataInputSchema = t.object({
  caseEntry: t.string(),
  maternalFetalAssessment: t.string(),
  interpretationAndPlan: t.string(),
  management: t.string(),
  reassessment: t.string(),
  deliveryPlanning: t.string(),
  postpartum: t.string(),
  outcomeReflection: t.string(),
})

const saveCaseInputSchema = t.object({
  curriculumId: t.string(),
  kind: caseKindSchema,
  name: t.string(),
  description: t.string(),
  gender: t.string(),
  caseData: t.object({ kind: caseKindSchema, payload: t.any() }),
  generatedQuestions: t.array(t.object({ prompt: t.string() })),
})

export const embeddingTask = defineTask({
  name: 'embedding.generate',
  input: t.object({ entity: t.string(), entityId: t.string() }),
  output: t.object({ ok: t.boolean() }),
  retry: { attempts: 3, backoff: 'exponential' },
})

export const outpatientCaseContentWorkflow = defineWorkflow({
  name: 'outpatient-case-content-generation',
  input: caseGenerationInputSchema,
  output: outpatientContentSchema,
  retention: '30d',
})
  .activity('draftCase', {
    input: caseGenerationInputSchema,
    output: t.object({ draft: t.string() }),
    retry: { attempts: 3, backoff: 'exponential' },
  })
  .activity('research', {
    input: t.object({ scenario: t.string(), draft: t.string() }),
    output: t.object({ research: t.string(), usage: usageSchema }),
    retry: { attempts: 3, backoff: 'exponential' },
  })
  .activity('blueprint', {
    input: t.object({
      scenario: t.string(),
      draft: t.string(),
      research: t.string(),
    }),
    output: t.object({ blueprint: t.string(), usage: usageSchema }),
  })
  .activity('review', {
    input: sectionInputSchema,
    output: t.object({ review: reviewSchema, usage: usageSchema }),
  })
  .activity('applyReview', {
    input: t.object({ blueprint: t.string(), review: reviewSchema }),
    output: t.object({ revisedBlueprint: t.string(), usage: usageSchema }),
  })
  .parallel('sections', (helpers) => ({
    patientBackground: helpers.activity({
      input: sectionInputSchema,
      output: t.object({ patientBackground: t.string(), usage: usageSchema }),
    }),
    differentialDiagnosis: helpers.activity({
      input: sectionInputSchema,
      output: t.object({
        differentialDiagnosis: t.string(),
        usage: usageSchema,
      }),
    }),
    labsAndDiagnostics: helpers.activity({
      input: sectionInputSchema,
      output: t.object({ labsAndDiagnostics: t.string(), usage: usageSchema }),
    }),
    treatmentPlan: helpers.activity({
      input: sectionInputSchema,
      output: t.object({ treatmentPlan: t.string(), usage: usageSchema }),
    }),
    outcome: helpers.activity({
      input: sectionInputSchema,
      output: t.object({ outcome: t.string(), usage: usageSchema }),
    }),
    caseIdentity: helpers.activity({
      input: sectionInputSchema,
      output: t.object({
        name: t.string(),
        description: t.string(),
        gender: t.string(),
        usage: usageSchema,
      }),
    }),
  }))
  .activity('composeContent', {
    input: composeOutpatientContentInputSchema,
    output: t.object({ content: t.string() }),
  })
  .build()

export const obstetricsCaseContentWorkflow = defineWorkflow({
  name: 'obstetrics-case-content-generation',
  input: caseGenerationInputSchema,
  output: obstetricsContentSchema,
  retention: '30d',
})
  .activity('draftCase', {
    input: caseGenerationInputSchema,
    output: t.object({ draft: t.string() }),
  })
  .activity('research', {
    input: t.object({ scenario: t.string(), draft: t.string() }),
    output: t.object({ research: t.string(), usage: usageSchema }),
  })
  .activity('blueprint', {
    input: t.object({ scenario: t.string(), research: t.string() }),
    output: t.object({ blueprint: t.string(), usage: usageSchema }),
  })
  .activity('review', {
    input: sectionInputSchema,
    output: t.object({ review: reviewSchema, usage: usageSchema }),
  })
  .activity('applyReview', {
    input: t.object({ blueprint: t.string(), review: reviewSchema }),
    output: t.object({ revisedBlueprint: t.string(), usage: usageSchema }),
  })
  .parallel('sections', (helpers) => ({
    caseEntry: helpers.activity({
      input: sectionInputSchema,
      output: t.object({ caseEntry: t.string(), usage: usageSchema }),
    }),
    maternalFetalAssessment: helpers.activity({
      input: sectionInputSchema,
      output: t.object({
        maternalFetalAssessment: t.string(),
        usage: usageSchema,
      }),
    }),
    interpretationAndPlan: helpers.activity({
      input: sectionInputSchema,
      output: t.object({
        interpretationAndPlan: t.string(),
        usage: usageSchema,
      }),
    }),
    laborManagement: helpers.activity({
      input: sectionInputSchema,
      output: t.object({ management: t.string(), usage: usageSchema }),
    }),
    reassessment: helpers.activity({
      input: sectionInputSchema,
      output: t.object({ reassessment: t.string(), usage: usageSchema }),
    }),
    deliveryPlanning: helpers.activity({
      input: sectionInputSchema,
      output: t.object({ deliveryPlanning: t.string(), usage: usageSchema }),
    }),
    postpartum: helpers.activity({
      input: sectionInputSchema,
      output: t.object({ postpartum: t.string(), usage: usageSchema }),
    }),
    outcomeReflection: helpers.activity({
      input: sectionInputSchema,
      output: t.object({ outcomeReflection: t.string(), usage: usageSchema }),
    }),
    caseIdentity: helpers.activity({
      input: sectionInputSchema,
      output: t.object({
        name: t.string(),
        description: t.string(),
        gender: t.string(),
        usage: usageSchema,
      }),
    }),
  }))
  .activity('composeObstetricsData', {
    input: composeObstetricsDataInputSchema,
    output: t.object({
      obstetricsData: obstetricsDataSchema,
      content: t.string(),
    }),
  })
  .build()

export const outpatientQuestionWorkflow = defineWorkflow({
  name: 'outpatient-question-generation',
  input: t.object({ content: t.string(), dreyfusLevels: t.array(t.string()) }),
  output: questionGenerationOutputSchema,
}).build()

export const obstetricsQuestionWorkflow = defineWorkflow({
  name: 'obstetrics-question-generation',
  input: t.object({
    obstetricsData: obstetricsDataSchema,
    dreyfusLevels: t.array(t.string()),
  }),
  output: questionGenerationOutputSchema,
}).build()

export const caseGenerationWorkflow = defineWorkflow({
  name: 'case-generation',
  input: caseGenerationInputSchema,
  output: t.object({
    caseId: t.string(),
    kind: caseKindSchema,
    usage: usageSchema,
    review: reviewSchema,
    questionReview: reviewSchema,
  }),
  retention: '30d',
})
  .branch('content', {
    cases: (helpers) => ({
      outpatient: helpers.workflow(outpatientCaseContentWorkflow, {
        cancellation: 'propagate',
      }),
      obstetrics: helpers.workflow(obstetricsCaseContentWorkflow, {
        cancellation: 'propagate',
      }),
    }),
  })
  .branch('questions', {
    output: questionGenerationOutputSchema,
    cases: (helpers) => ({
      outpatient: helpers.workflow(outpatientQuestionWorkflow, {
        cancellation: 'propagate',
      }),
      obstetrics: helpers.workflow(obstetricsQuestionWorkflow, {
        cancellation: 'propagate',
      }),
    }),
  })
  .activity('saveCase', {
    input: saveCaseInputSchema,
    output: t.object({ caseId: t.string() }),
  })
  .task('embedding', embeddingTask)
  .build()

export const curriculumGenerationWorkflow = defineWorkflow({
  name: 'curriculum-generation',
  input: t.object({
    curriculum: t.string(),
    caseCount: t.number(),
  }),
  output: t.object({
    specsWithScenarios: t.array(curriculumScenarioSchema),
    caseRuns: t.array(t.object({ runId: t.string(), status: t.string() })),
    embeddingResults: t.array(
      t.object({ index: t.number(), status: t.string() }),
    ),
    usage: usageSchema,
  }),
  retention: '30d',
})
  .activity('loadCurriculumContext', {
    input: t.object({ curriculum: t.string() }),
    output: t.object({
      curriculumId: t.string(),
      defaultCaseKind: caseKindSchema,
    }),
  })
  .activity('generateSpecs', {
    input: t.object({
      curriculum: t.string(),
      caseCount: t.number(),
    }),
    output: t.object({
      specs: t.array(curriculumSpecSchema),
      usage: usageSchema,
    }),
    retry: { attempts: 1 },
  })
  .activity('dedupeSpecs', {
    input: t.object({ specs: t.array(curriculumSpecSchema) }),
    output: t.object({ specs: t.array(curriculumSpecSchema) }),
  })
  .activity('generateScenarios', {
    input: t.object({ specs: t.array(curriculumSpecSchema) }),
    output: t.object({
      specsWithScenarios: t.array(curriculumScenarioSchema),
      usage: usageSchema,
    }),
  })
  .mapWorkflow('caseRuns', caseGenerationWorkflow, {
    item: curriculumScenarioSchema,
    mode: 'start-only',
    concurrency: 20,
    cancellation: 'propagate',
  })
  .mapTask('scenarioEmbeddings', embeddingTask, {
    item: curriculumScenarioSchema,
    mode: 'wait-settled',
    concurrency: 20,
    retry: { attempts: 3, backoff: 'exponential' },
  })
  .build()

const skippedReview = { status: 'skipped' }
const zeroUsage = { totalCost: 0 }

export const embeddingImpl = implementTask(embeddingTask, {
  idempotency: (_, input) => [
    'embedding.generate',
    input.entity,
    input.entityId,
  ],
  async handler(_, input) {
    return { ok: Boolean(input.entity && input.entityId) }
  },
})

export const outpatientCaseContentWorkflowImpl = implementWorkflow(
  outpatientCaseContentWorkflow,
)
  .draftCase(async (_, input) => ({ draft: input.scenario }), {
    input: (_, _outputs, input) => input,
  })
  .research(
    async (_, input) => ({
      research: `${input.scenario}\n${input.draft}`,
      usage: zeroUsage,
    }),
    {
      input: (_, { draftCase }, input) => ({
        scenario: input.scenario,
        draft: draftCase.draft,
      }),
    },
  )
  .blueprint(
    async (_, input) => ({
      blueprint: `${input.scenario}\n${input.draft}\n${input.research}`,
      usage: zeroUsage,
    }),
    {
      input: (_, { draftCase, research }, input) => ({
        scenario: input.scenario,
        draft: draftCase.draft,
        research: research.research,
      }),
    },
  )
  .review(async () => ({ review: skippedReview, usage: zeroUsage }), {
    input: (_, { blueprint }) => ({ blueprint: blueprint.blueprint }),
  })
  .applyReview(
    async (_, input) => ({
      revisedBlueprint: input.blueprint,
      usage: zeroUsage,
    }),
    {
      input: (_, { blueprint, review }) => ({
        blueprint: blueprint.blueprint,
        review: review.review,
      }),
    },
  )
  .sections((helpers) => ({
    patientBackground: helpers.activity(
      async (_, input) => ({
        patientBackground: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    differentialDiagnosis: helpers.activity(
      async (_, input) => ({
        differentialDiagnosis: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    labsAndDiagnostics: helpers.activity(
      async (_, input) => ({
        labsAndDiagnostics: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    treatmentPlan: helpers.activity(
      async (_, input) => ({
        treatmentPlan: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    outcome: helpers.activity(
      async (_, input) => ({ outcome: input.blueprint, usage: zeroUsage }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    caseIdentity: helpers.activity(
      async (_, input) => ({
        name: input.blueprint,
        description: input.blueprint,
        gender: 'unknown',
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
  }))
  .composeContent(
    async (_, input) => ({
      content: [
        input.patientBackground,
        input.differentialDiagnosis,
        input.labsAndDiagnostics,
        input.treatmentPlan,
        input.outcome,
      ].join('\n'),
    }),
    {
      input: (_, { sections }) => ({
        patientBackground: sections.patientBackground.patientBackground,
        differentialDiagnosis:
          sections.differentialDiagnosis.differentialDiagnosis,
        labsAndDiagnostics: sections.labsAndDiagnostics.labsAndDiagnostics,
        treatmentPlan: sections.treatmentPlan.treatmentPlan,
        outcome: sections.outcome.outcome,
      }),
    },
  )
  .finish((_, { sections, composeContent, review, research }) => ({
    kind: 'outpatient',
    name: sections.caseIdentity.name,
    description: sections.caseIdentity.description,
    gender: sections.caseIdentity.gender,
    content: composeContent.content,
    review: review.review,
    usage: research.usage,
  }))

export const obstetricsCaseContentWorkflowImpl = implementWorkflow(
  obstetricsCaseContentWorkflow,
)
  .draftCase(async (_, input) => ({ draft: input.scenario }), {
    input: (_, _outputs, input) => input,
  })
  .research(
    async (_, input) => ({
      research: `${input.scenario}\n${input.draft}`,
      usage: zeroUsage,
    }),
    {
      input: (_, { draftCase }, input) => ({
        scenario: input.scenario,
        draft: draftCase.draft,
      }),
    },
  )
  .blueprint(
    async (_, input) => ({
      blueprint: `${input.scenario}\n${input.research}`,
      usage: zeroUsage,
    }),
    {
      input: (_, { research }, input) => ({
        scenario: input.scenario,
        research: research.research,
      }),
    },
  )
  .review(async () => ({ review: skippedReview, usage: zeroUsage }), {
    input: (_, { blueprint }) => ({ blueprint: blueprint.blueprint }),
  })
  .applyReview(
    async (_, input) => ({
      revisedBlueprint: input.blueprint,
      usage: zeroUsage,
    }),
    {
      input: (_, { blueprint, review }) => ({
        blueprint: blueprint.blueprint,
        review: review.review,
      }),
    },
  )
  .sections((helpers) => ({
    caseEntry: helpers.activity(
      async (_, input) => ({ caseEntry: input.blueprint, usage: zeroUsage }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    maternalFetalAssessment: helpers.activity(
      async (_, input) => ({
        maternalFetalAssessment: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    interpretationAndPlan: helpers.activity(
      async (_, input) => ({
        interpretationAndPlan: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    laborManagement: helpers.activity(
      async (_, input) => ({
        management: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    reassessment: helpers.activity(
      async (_, input) => ({
        reassessment: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    deliveryPlanning: helpers.activity(
      async (_, input) => ({
        deliveryPlanning: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    postpartum: helpers.activity(
      async (_, input) => ({
        postpartum: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    outcomeReflection: helpers.activity(
      async (_, input) => ({
        outcomeReflection: input.blueprint,
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
    caseIdentity: helpers.activity(
      async (_, input) => ({
        name: input.blueprint,
        description: input.blueprint,
        gender: 'unknown',
        usage: zeroUsage,
      }),
      {
        input: (_, { applyReview }) => ({
          blueprint: applyReview.revisedBlueprint,
        }),
      },
    ),
  }))
  .composeObstetricsData(
    async (_, input) => ({
      obstetricsData: input,
      content: Object.values(input).join('\n'),
    }),
    {
      input: (_, { sections }) => ({
        caseEntry: sections.caseEntry.caseEntry,
        maternalFetalAssessment:
          sections.maternalFetalAssessment.maternalFetalAssessment,
        interpretationAndPlan:
          sections.interpretationAndPlan.interpretationAndPlan,
        management: sections.laborManagement.management,
        reassessment: sections.reassessment.reassessment,
        deliveryPlanning: sections.deliveryPlanning.deliveryPlanning,
        postpartum: sections.postpartum.postpartum,
        outcomeReflection: sections.outcomeReflection.outcomeReflection,
      }),
    },
  )
  .finish((_, { sections, composeObstetricsData, review, research }) => ({
    kind: 'obstetrics',
    name: sections.caseIdentity.name,
    description: sections.caseIdentity.description,
    gender: sections.caseIdentity.gender,
    content: composeObstetricsData.content,
    obstetricsData: composeObstetricsData.obstetricsData,
    review: review.review,
    usage: research.usage,
  }))

export const outpatientQuestionWorkflowImpl = implementWorkflow(
  outpatientQuestionWorkflow,
).finish((_, _outputs, input) => ({
  caseData: { kind: 'outpatient', payload: input.content },
  generatedQuestions: [],
  questionReview: skippedReview,
  usage: zeroUsage,
}))

export const obstetricsQuestionWorkflowImpl = implementWorkflow(
  obstetricsQuestionWorkflow,
).finish((_, _outputs, input) => ({
  caseData: { kind: 'obstetrics', payload: input.obstetricsData },
  generatedQuestions: [],
  questionReview: skippedReview,
  usage: zeroUsage,
}))

export const caseGenerationWorkflowImpl = implementWorkflow(
  caseGenerationWorkflow,
  {
    tags: (_, input) => ({
      curriculumId: input.curriculumId,
      kind: input.kind,
    }),
    idempotency: (_, input) => [
      'case-generation',
      input.curriculumId,
      input.kind,
      input.scenario,
    ],
  },
)
  .content({
    select: (_, _outputs, input) => input.kind,
    cases: ({ workflow }) => ({
      outpatient: workflow(outpatientCaseContentWorkflow, {
        input: (_, _outputs, input) => input,
      }),
      obstetrics: workflow(obstetricsCaseContentWorkflow, {
        input: (_, _outputs, input) => input,
      }),
    }),
  })
  .questions({
    select: (_, _outputs, input) => input.kind,
    cases: ({ workflow }) => ({
      outpatient: workflow(outpatientQuestionWorkflow, {
        input: (_, { content }, input) => ({
          content: content.content,
          dreyfusLevels: input.dreyfusLevels,
        }),
      }),
      obstetrics: workflow(obstetricsQuestionWorkflow, {
        input: (_, { content }, input) => {
          if (content.kind !== 'obstetrics') {
            throw new Error('Expected obstetrics content')
          }

          return {
            obstetricsData: content.obstetricsData,
            dreyfusLevels: input.dreyfusLevels,
          }
        },
      }),
    }),
  })
  .saveCase(
    async (_, input) => ({
      caseId: `${input.curriculumId}:${input.kind}:${input.name}`,
    }),
    {
      input: (_, { content, questions }, input) => ({
        curriculumId: input.curriculumId,
        kind: input.kind,
        name: content.name,
        description: content.description,
        gender: content.gender,
        caseData: questions.caseData,
        generatedQuestions: questions.generatedQuestions,
      }),
      idempotency: (_, _outputs, input) => [
        'save-generated-case',
        input.curriculumId,
        input.kind,
        input.scenario,
      ],
    },
  )
  .embedding(embeddingTask, {
    input: (_, { saveCase }) => ({
      entity: 'curriculum_case',
      entityId: saveCase.caseId,
    }),
  })
  .finish((_, { saveCase, content, questions }, input) => ({
    caseId: saveCase.caseId,
    kind: input.kind,
    usage: content.usage,
    review: content.review,
    questionReview: questions.questionReview,
  }))

export const curriculumGenerationWorkflowImpl = implementWorkflow(
  curriculumGenerationWorkflow,
  {
    tags: (_, input) => ({ curriculum: input.curriculum }),
    idempotency: (_, input) => [
      'curriculum-generation',
      input.curriculum,
      input.caseCount,
    ],
  },
)
  .loadCurriculumContext(
    async (_, input) => ({
      curriculumId: input.curriculum,
      defaultCaseKind: 'outpatient',
    }),
    {
      input: (_, _outputs, input) => ({ curriculum: input.curriculum }),
    },
  )
  .generateSpecs(
    async (_, input) => ({
      specs: Array.from({ length: input.caseCount }, (_, index) => ({
        id: `${input.curriculum}:${index}`,
        domain: input.curriculum,
        title: `${input.curriculum} ${index}`,
        dreyfusLevels: [],
      })),
      usage: zeroUsage,
    }),
    {
      input: (_, _outputs, input) => ({
        curriculum: input.curriculum,
        caseCount: input.caseCount,
      }),
    },
  )
  .dedupeSpecs(async (_, input) => ({ specs: input.specs }), {
    input: (_, { generateSpecs }) => ({ specs: generateSpecs.specs }),
  })
  .generateScenarios(
    async (_, input) => ({
      specsWithScenarios: input.specs.map((spec) => ({
        ...spec,
        scenario: spec.title,
      })),
      usage: zeroUsage,
    }),
    {
      input: (_, { dedupeSpecs }) => ({ specs: dedupeSpecs.specs }),
    },
  )
  .caseRuns(caseGenerationWorkflow, {
    items: (_, { generateScenarios }) => generateScenarios.specsWithScenarios,
    input: (_, { loadCurriculumContext }, item) => ({
      curriculumId: loadCurriculumContext.curriculumId,
      scenario: item.scenario,
      kind: loadCurriculumContext.defaultCaseKind,
      dreyfusLevels: item.dreyfusLevels,
    }),
    idempotency: (_, _outputs, item, input) => [
      'curriculum-case-generation-run',
      input.curriculum,
      item.id,
    ],
  })
  .scenarioEmbeddings(embeddingTask, {
    items: (_, { generateScenarios }) => generateScenarios.specsWithScenarios,
    input: (_, _outputs, item) => ({
      entity: 'curriculum_scenario',
      entityId: item.id,
    }),
    idempotency: (_, _outputs, item, input) => [
      'curriculum-scenario-embedding',
      input.curriculum,
      item.id,
    ],
  })
  .finish((_, { generateScenarios, caseRuns, scenarioEmbeddings }) => ({
    specsWithScenarios: generateScenarios.specsWithScenarios,
    caseRuns: caseRuns.items.map(({ runId, status }) => ({ runId, status })),
    embeddingResults: scenarioEmbeddings.items.map(({ index, status }) => ({
      index,
      status,
    })),
    usage: generateScenarios.usage,
  }))

export const casenetworkWorkflowApiGaps = [
  'Definition graph no longer exposes data dependencies because all input/items/select mapping moved to implementation; good separation, but weaker for static UI/progress graph introspection.',
  'Progress/events are still not first-class: no typed emit, progress schema, usage timeline, or watch stream for page/spec/child-run dashboards.',
  'No concrete WorkflowClient exists yet; Casenetwork operations will need tags, parent/child run lookup, cursor pagination, event stream, and progress projection once the client is added.',
  'mapWorkflow has start-only/wait-all/wait-settled, but no partial failure policy, failure threshold, or per-item error classification beyond the settled output shape.',
  'Current implementation builder validates runnable identity but does not retain task/workflow/map mapping options or finish output mapper at runtime yet.',
] as const
