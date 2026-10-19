import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const OCTAVE_PATTERN_IDS = [
  'runs',
  'jumps',
  'repeated',
  'long-mixed',
] as const;

export const OCTAVE_METHOD_IDS = [
  'octave-separate-finger-lines',
  'octave-dotted-rhythm-variations',
  'octave-expanding-five-note-pattern',
  'octave-five-note-alternating-accents',
  'octave-progressive-groups-with-rests',
] as const;

const OCTAVE_PAIR_RULE_IDS = [
  'runs-three-attacks',
  'runs-four-or-more',
  'jumps-four-or-more',
  'jumps-fewer-than-four',
  'repeated-octaves',
  'long-mixed-octaves',
] as const;

const OctavePatternSchema = z.enum(OCTAVE_PATTERN_IDS);
const OctaveMethodIdSchema = z.enum(OCTAVE_METHOD_IDS);
const OctavePairRuleIdSchema = z.enum(OCTAVE_PAIR_RULE_IDS);
const InstructionPairSchema = z.tuple([
  z.string().trim().min(4).max(240),
  z.string().trim().min(4).max(240),
]);

const ApplicabilityRangeSchema = z.object({
  patterns: z.array(OctavePatternSchema).min(1).max(OCTAVE_PATTERN_IDS.length),
  minimumAttacks: z.number().int().min(1).max(64),
  maximumAttacks: z.number().int().min(1).max(64).nullable(),
}).strict();

const TogetherHandsSchema = z.object({
  oneHand: z.literal('write-only-the-affected-hand'),
  bothHands: z.literal('write-both-affected-hands-together-with-aligned-timing'),
}).strict();

const SeparateHandsSchema = z.object({
  oneHand: z.literal('write-only-the-affected-hand'),
  bothHands: z.literal('generate-a-separate-sequence-for-each-affected-hand'),
}).strict();

const AlignedHandsSchema = z.object({
  oneHand: z.literal('write-only-the-affected-hand'),
  bothHands: z.literal('write-both-affected-hands-with-aligned-timing'),
}).strict();

const SeparateFingerLinesMethodSchema = z.object({
  id: z.literal('octave-separate-finger-lines'),
  exerciseNumber: z.literal(1),
  title: z.string().trim().min(2).max(80),
  instructions: InstructionPairSchema,
  applicability: ApplicabilityRangeSchema.extend({
    patterns: z.tuple([
      z.literal('runs'),
      z.literal('jumps'),
      z.literal('repeated'),
      z.literal('long-mixed'),
    ]),
    minimumAttacks: z.literal(2),
    maximumAttacks: z.null(),
  }).strict(),
  hands: TogetherHandsSchema,
  notation: z.object({
    measureCount: z.literal(2),
    passes: z.tuple([
      z.literal('outer-finger-line'),
      z.literal('finger-one-line'),
    ]),
    noteType: z.literal('eighth'),
    preserveOriginalRhythm: z.literal(false),
    preserveSourcePitchOrder: z.literal(true),
    firstMeasure: z.string().trim().min(10).max(240),
    secondMeasure: z.string().trim().min(10).max(240),
  }).strict(),
}).strict();

const DottedRhythmMethodSchema = z.object({
  id: z.literal('octave-dotted-rhythm-variations'),
  exerciseNumber: z.literal(2),
  title: z.string().trim().min(2).max(80),
  instructions: InstructionPairSchema,
  applicability: ApplicabilityRangeSchema.extend({
    patterns: z.tuple([
      z.literal('runs'),
      z.literal('jumps'),
      z.literal('repeated'),
      z.literal('long-mixed'),
    ]),
    minimumAttacks: z.literal(2),
    maximumAttacks: z.null(),
  }).strict(),
  hands: TogetherHandsSchema,
  notation: z.object({
    measureCount: z.literal(2),
    passes: z.tuple([
      z.literal('dotted-eighth-sixteenth'),
      z.literal('sixteenth-dotted-eighth'),
    ]),
    preserveOriginalRhythm: z.literal(false),
    preserveSourcePitchOrder: z.literal(true),
    keepFullOctaves: z.literal(true),
    firstMeasureDurations: z.tuple([
      z.literal('dotted-eighth'),
      z.literal('sixteenth'),
    ]),
    secondMeasureDurations: z.tuple([
      z.literal('sixteenth'),
      z.literal('dotted-eighth'),
    ]),
  }).strict(),
}).strict();

const ExpandingPatternMethodSchema = z.object({
  id: z.literal('octave-expanding-five-note-pattern'),
  exerciseNumber: z.literal(3),
  title: z.string().trim().min(2).max(80),
  instructions: InstructionPairSchema,
  applicability: ApplicabilityRangeSchema.extend({
    patterns: z.tuple([z.literal('runs')]),
    minimumAttacks: z.literal(3),
    maximumAttacks: z.null(),
  }).strict(),
  hands: SeparateHandsSchema,
  notation: z.object({
    passes: z.tuple([
      z.literal('two-note'),
      z.literal('three-note'),
      z.literal('four-note'),
      z.literal('five-note'),
    ]),
    noteType: z.literal('eighth'),
    preserveOriginalRhythm: z.literal(false),
    startingPitch: z.literal('lowest-source-octave-position'),
    followOriginalKeySignature: z.literal(true),
    keepFullOctaves: z.literal(true),
    scaleDegreePatterns: z.tuple([
      z.tuple([z.literal(1), z.literal(2), z.literal(1), z.literal(2)]),
      z.tuple([z.literal(1), z.literal(2), z.literal(3), z.literal(2), z.literal(1)]),
      z.tuple([
        z.literal(1), z.literal(2), z.literal(3), z.literal(4),
        z.literal(3), z.literal(2), z.literal(1),
      ]),
      z.tuple([
        z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
        z.literal(4), z.literal(3), z.literal(2), z.literal(1),
      ]),
    ]),
    directionAboveExercise: z.string().trim().min(10).max(240),
  }).strict(),
}).strict();

const AlternatingAccentsMethodSchema = z.object({
  id: z.literal('octave-five-note-alternating-accents'),
  exerciseNumber: z.literal(4),
  title: z.string().trim().min(2).max(80),
  instructions: InstructionPairSchema,
  applicability: ApplicabilityRangeSchema.extend({
    patterns: z.tuple([z.literal('runs')]),
    minimumAttacks: z.literal(3),
    maximumAttacks: z.null(),
    excludePatterns: z.tuple([z.literal('jumps')]),
  }).strict(),
  hands: SeparateHandsSchema,
  notation: z.object({
    measureCount: z.literal(2),
    passes: z.tuple([z.literal('five-note-ascending-descending-twice')]),
    noteType: z.literal('eighth'),
    preserveOriginalRhythm: z.literal(false),
    startingPitch: z.literal('lowest-source-octave-position'),
    followOriginalKeySignature: z.literal(true),
    expandToFiveNotesWhenSourceIsShorter: z.literal(true),
    keepFullOctaves: z.literal(true),
    scaleDegreePatternPerMeasure: z.tuple([
      z.literal(1), z.literal(2), z.literal(3), z.literal(4),
      z.literal(5), z.literal(4), z.literal(3), z.literal(2),
    ]),
    accentEventIndexesPerMeasure: z.tuple([z.literal(0), z.literal(4)]),
    accentBeatsPerMeasure: z.tuple([z.literal(1), z.literal(3)]),
    directionAboveExercise: z.string().trim().min(10).max(240),
  }).strict(),
}).strict();

const ProgressiveGroupsMethodSchema = z.object({
  id: z.literal('octave-progressive-groups-with-rests'),
  exerciseNumber: z.literal(5),
  title: z.string().trim().min(2).max(80),
  instructions: InstructionPairSchema,
  applicability: ApplicabilityRangeSchema.extend({
    patterns: z.tuple([
      z.literal('runs'),
      z.literal('jumps'),
      z.literal('long-mixed'),
    ]),
    minimumAttacks: z.literal(4),
    maximumAttacks: z.null(),
    allowStepwiseMotion: z.literal(true),
    allowJumps: z.literal(true),
  }).strict(),
  hands: AlignedHandsSchema,
  notation: z.object({
    passes: z.tuple([z.literal('progressively-longer-source-prefixes')]),
    noteType: z.literal('eighth'),
    preserveOriginalRhythm: z.literal(false),
    preserveSourcePitchOrder: z.literal(true),
    keepFullOctaves: z.literal(true),
    groupCountFormula: z.literal('min(3, totalOctaveAttacks - 1)'),
    maximumGeneratedGroups: z.literal(3),
    addOneOctavePerGroup: z.literal(true),
    restAfterEveryGroup: z.literal(true),
    doNotWriteEntireExercise: z.literal(true),
    directionAfterFinalGroup: z.string().trim().min(2).max(40),
  }).strict(),
}).strict();

const OctaveMethodSchema = z.discriminatedUnion('id', [
  SeparateFingerLinesMethodSchema,
  DottedRhythmMethodSchema,
  ExpandingPatternMethodSchema,
  AlternatingAccentsMethodSchema,
  ProgressiveGroupsMethodSchema,
]);

const PairRuleSchema = z.object({
  id: OctavePairRuleIdSchema,
  pattern: OctavePatternSchema,
  minimumAttacks: z.number().int().min(1).max(64),
  maximumAttacks: z.number().int().min(1).max(64).nullable(),
  methodIds: z.tuple([OctaveMethodIdSchema, OctaveMethodIdSchema]),
}).strict();

const OctavePracticeRulesSchema = z.object({
  schemaVersion: z.literal(4),
  id: z.literal('octave-practice-rules'),
  source: z.object({
    document: z.literal('Octaves_Exercises.docx'),
    sha256: z.literal('c6a43302e925103e038adc8a42e0c76345a06e88e7f1d425ae3d1ed45aee7569'),
    treatAsTeachingReferenceOnly: z.literal(true),
    loadDocumentAtRuntime: z.literal(false),
  }).strict(),
  exerciseCount: z.literal(2),
  globalNotation: z.object({
    separateExerciseSystems: z.literal(true),
    combineExercises: z.literal(false),
    defaultNoteType: z.literal('eighth'),
    defaultDurationQuarterNotes: z.literal(0.5),
    rhythmExceptionMethodIds: z.tuple([
      z.literal('octave-dotted-rhythm-variations'),
    ]),
    followOriginalKeySignature: z.literal(true),
    preserveSourcePitchOrderWhenApplicable: z.literal(true),
    instructionSentencesPerExercise: z.literal(2),
    validateMusicXmlBeforeDisplay: z.literal(true),
  }).strict(),
  detection: z.object({
    octaveSemitones: z.literal(12),
    requireSameStepAndAlter: z.literal(true),
    minimumRunAttacks: z.number().int().min(2).max(16),
    maximumScaleLikeStepSemitones: z.number().int().min(1).max(4),
    maximumRunOnsetRatio: z.number().min(1).max(4),
    minimumJumpSemitones: z.number().int().min(2).max(12),
    progressiveMinimumAttacks: z.number().int().min(4).max(32),
    minimumRepeatedOrJumpAttacks: z.number().int().min(2).max(8),
    onsetToleranceQuarterNotes: z.number().positive().max(0.001),
    durationToleranceQuarterNotes: z.number().positive().max(0.001),
    ignoreIsolatedOctaves: z.literal(true),
    ignoreGraceNotes: z.literal(true),
    ignoreTieStopContinuations: z.literal(true),
  }).strict(),
  handRules: z.object({
    inferOnlyFromTwoStaffPianoPart: z.literal(true),
    staffOne: z.literal('right'),
    staffTwo: z.literal('left'),
    rightHand: z.object({
      outerPitch: z.literal('upper'),
      thumbPitch: z.literal('lower'),
    }).strict(),
    leftHand: z.object({
      outerPitch: z.literal('lower'),
      thumbPitch: z.literal('upper'),
    }).strict(),
    outerFingerByKeyColor: z.object({
      white: z.literal(5),
      black: z.literal(4),
    }).strict(),
    keyColorFromSoundingPitchClass: z.literal(true),
    thumbFinger: z.literal(1),
    oneHandNotation: z.literal('affected-hand-only'),
    bothHandsNotation: z.literal('both-hands-with-aligned-timing'),
    separateHandsWhenMethodRequires: z.literal(true),
    sourceFingeringsTakePriority: z.literal(false),
    documentFingerRulesTakePriority: z.literal(true),
  }).strict(),
  selection: z.object({
    owner: z.literal('application'),
    exerciseCount: z.literal(2),
    firstMatchingPairRuleWins: z.literal(true),
    mixedPassagePriority: z.tuple([
      z.literal('long-mixed'),
      z.literal('jumps'),
      z.literal('repeated'),
      z.literal('runs'),
    ]),
    pairRules: z.array(PairRuleSchema).length(OCTAVE_PAIR_RULE_IDS.length),
  }).strict(),
  wording: z.object({
    enduranceDirection: z.string().trim().min(10).max(240),
    continuationDirection: z.string().trim().min(2).max(40),
  }).strict(),
  methods: z.array(OctaveMethodSchema).length(OCTAVE_METHOD_IDS.length),
}).strict().superRefine((rules, context) => {
  const methodsById = new Map(rules.methods.map((method) => [method.id, method]));
  if (
    methodsById.size !== OCTAVE_METHOD_IDS.length
    || OCTAVE_METHOD_IDS.some((methodId) => !methodsById.has(methodId))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['methods'],
      message: 'The octave rules must define each supported method exactly once.',
    });
  }

  const pairRuleIds = rules.selection.pairRules.map((rule) => rule.id);
  if (new Set(pairRuleIds).size !== pairRuleIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['selection', 'pairRules'],
      message: 'Octave pair-rule identifiers must be unique.',
    });
  }

  rules.selection.pairRules.forEach((rule, ruleIndex) => {
    const rulePath = ['selection', 'pairRules', ruleIndex] as const;
    if (rule.maximumAttacks !== null && rule.maximumAttacks < rule.minimumAttacks) {
      context.addIssue({
        code: 'custom',
        path: [...rulePath, 'maximumAttacks'],
        message: 'A pair rule maximum cannot be lower than its minimum.',
      });
    }
    if (rule.methodIds[0] === rule.methodIds[1]) {
      context.addIssue({
        code: 'custom',
        path: [...rulePath, 'methodIds'],
        message: 'A pair rule must reference two distinct methods.',
      });
    }

    for (const methodId of rule.methodIds) {
      const method = methodsById.get(methodId);
      if (!method) {
        context.addIssue({
          code: 'custom',
          path: [...rulePath, 'methodIds'],
          message: `Pair rule ${rule.id} references a missing method.`,
        });
        continue;
      }
      const applicability = method.applicability;
      const applicablePatterns: readonly OctavePattern[] = applicability.patterns;
      const excludedPatterns: readonly OctavePattern[] = 'excludePatterns' in applicability
        ? applicability.excludePatterns
        : [];
      if (
        !applicablePatterns.includes(rule.pattern)
        || excludedPatterns.includes(rule.pattern)
        || rule.minimumAttacks < applicability.minimumAttacks
        || (
          rule.maximumAttacks === null
            ? applicability.maximumAttacks !== null
            : applicability.maximumAttacks !== null
              && rule.maximumAttacks > applicability.maximumAttacks
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: [...rulePath, 'methodIds'],
          message: `Pair rule ${rule.id} references method ${methodId} outside its applicability.`,
        });
      }
    }
  });
});

export type OctavePattern = z.infer<typeof OctavePatternSchema>;
export type OctaveMethodId = z.infer<typeof OctaveMethodIdSchema>;
export type OctavePracticeMethod = z.infer<typeof OctaveMethodSchema>;
export type OctavePairRule = z.infer<typeof PairRuleSchema>;
export type OctavePracticeRules = z.infer<typeof OctavePracticeRulesSchema>;

const RULES_URL = new URL('../Practice_Rules/octave-practice-rules.json', import.meta.url);
let rulesFileReadCount = 0;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function loadRulesOnce(): Readonly<OctavePracticeRules> {
  rulesFileReadCount += 1;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(RULES_URL, 'utf8'));
  } catch (error) {
    throw new Error('The octave practice rules could not be loaded.', { cause: error });
  }
  const parsed = OctavePracticeRulesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`The octave practice rules are invalid: ${z.prettifyError(parsed.error)}`);
  }
  return deepFreeze(parsed.data);
}

const OCTAVE_RULES = loadRulesOnce();

export function getOctavePracticeRules(): Readonly<OctavePracticeRules> {
  return OCTAVE_RULES;
}

export function getOctaveRulesFileReadCount(): number {
  return rulesFileReadCount;
}

export function selectOctavePairRule(
  pattern: OctavePattern,
  attackCount: number,
): Readonly<OctavePairRule> | null {
  if (!Number.isInteger(attackCount) || attackCount < 1) return null;
  return OCTAVE_RULES.selection.pairRules.find((rule) => (
    rule.pattern === pattern
    && attackCount >= rule.minimumAttacks
    && (rule.maximumAttacks === null || attackCount <= rule.maximumAttacks)
  )) ?? null;
}

export function selectOctaveMethodPair(
  pattern: OctavePattern,
  attackCount: number,
): readonly [OctaveMethodId, OctaveMethodId] | null {
  return selectOctavePairRule(pattern, attackCount)?.methodIds ?? null;
}

export function getOctaveMethod(methodId: OctaveMethodId): Readonly<OctavePracticeMethod> {
  const method = OCTAVE_RULES.methods.find((candidate) => candidate.id === methodId);
  if (!method) throw new Error(`The octave practice rules are missing method ${methodId}.`);
  return method;
}

export function octaveMethodPromptSummary(methodId: OctaveMethodId): Record<string, unknown> {
  const method = getOctaveMethod(methodId);
  return {
    id: method.id,
    exerciseNumber: method.exerciseNumber,
    title: method.title,
    instructions: method.instructions,
    applicability: method.applicability,
    hands: method.hands,
    notation: method.notation,
  };
}

export function octavePracticeRulesPromptSummary(): Record<string, unknown> {
  return {
    rulesVersion: OCTAVE_RULES.schemaVersion,
    ruleSetId: OCTAVE_RULES.id,
    source: {
      document: OCTAVE_RULES.source.document,
      treatAsTeachingReferenceOnly: OCTAVE_RULES.source.treatAsTeachingReferenceOnly,
    },
    exerciseCount: OCTAVE_RULES.exerciseCount,
    globalNotation: OCTAVE_RULES.globalNotation,
    detection: OCTAVE_RULES.detection,
    handRules: OCTAVE_RULES.handRules,
    selection: OCTAVE_RULES.selection,
    wording: OCTAVE_RULES.wording,
    methods: OCTAVE_RULES.methods.map((method) => octaveMethodPromptSummary(method.id)),
  };
}

export function octavePairPromptSummary(
  pattern: OctavePattern,
  attackCount: number,
): Record<string, unknown> | null {
  const rule = selectOctavePairRule(pattern, attackCount);
  if (!rule) return null;
  return {
    rulesVersion: OCTAVE_RULES.schemaVersion,
    ruleSetId: OCTAVE_RULES.id,
    sourceDocument: OCTAVE_RULES.source.document,
    ruleId: rule.id,
    pattern,
    attackCount,
    methodIds: rule.methodIds,
    methods: rule.methodIds.map(octaveMethodPromptSummary),
  };
}
