import { randomInt } from 'node:crypto';
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
  'octave-repeated-pairs-alternating-accents',
] as const;

const OctavePatternSchema = z.enum(OCTAVE_PATTERN_IDS);
const OctaveMethodIdSchema = z.enum(OCTAVE_METHOD_IDS);

function isShortInstructionSentence(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized.endsWith('.') || normalized.includes(';')) return false;
  if (/[.!?]/.test(normalized.slice(0, -1))) return false;
  const wordCount = normalized.slice(0, -1).split(' ').filter(Boolean).length;
  return wordCount >= 4 && wordCount <= 20;
}

const InstructionSentenceSchema = z.string().trim().min(12).max(240).refine(
  isShortInstructionSentence,
  'Each instruction must be one simple sentence of four to twenty words ending in a period.',
);

const InstructionPairSchema = z.tuple([
  InstructionSentenceSchema,
  InstructionSentenceSchema,
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
    patterns: z.tuple([
      z.literal('runs'),
      z.literal('jumps'),
      z.literal('repeated'),
      z.literal('long-mixed'),
    ]),
    minimumAttacks: z.literal(2),
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
    minimumAttacks: z.literal(2),
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
    requireConsecutiveAttacks: z.literal(true),
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

const RepeatedPairsAlternatingAccentsMethodSchema = z.object({
  id: z.literal('octave-repeated-pairs-alternating-accents'),
  exerciseNumber: z.literal(6),
  title: z.string().trim().min(2).max(80),
  instructions: InstructionPairSchema,
  applicability: ApplicabilityRangeSchema.extend({
    patterns: z.tuple([
      z.literal('runs'),
      z.literal('jumps'),
      z.literal('long-mixed'),
    ]),
    minimumAttacks: z.literal(2),
    maximumAttacks: z.null(),
  }).strict(),
  hands: SeparateHandsSchema,
  notation: z.object({
    measureCount: z.literal(2),
    passes: z.tuple([
      z.literal('accent-first-of-pair'),
      z.literal('accent-second-of-pair'),
    ]),
    noteType: z.literal('eighth'),
    preserveOriginalRhythm: z.literal(false),
    preserveSourcePitchOrder: z.literal(true),
    keepFullOctaves: z.literal(true),
    positionCount: z.literal(4),
    repeatEachPosition: z.literal(2),
    cyclePositionsWhenSourceIsShorter: z.literal(true),
    truncatePositionsWhenSourceIsLonger: z.literal(true),
    firstMeasureAccentEventIndexes: z.tuple([
      z.literal(0), z.literal(2), z.literal(4), z.literal(6),
    ]),
    secondMeasureAccentEventIndexes: z.tuple([
      z.literal(1), z.literal(3), z.literal(5), z.literal(7),
    ]),
  }).strict(),
}).strict();

const OctaveMethodSchema = z.discriminatedUnion('id', [
  SeparateFingerLinesMethodSchema,
  DottedRhythmMethodSchema,
  ExpandingPatternMethodSchema,
  AlternatingAccentsMethodSchema,
  ProgressiveGroupsMethodSchema,
  RepeatedPairsAlternatingAccentsMethodSchema,
]);

const OctavePracticeRulesSchema = z.object({
  schemaVersion: z.literal(5),
  id: z.literal('czerny-etude-49-practice-rules'),
  source: z.object({
    document: z.literal('Czerny_etude_49.docx'),
    sha256: z.literal('7b3e3784a32f085c7f130a099e612b664a6ae5eb61d7f3a4f8be777660fc1e59'),
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
    strategy: z.literal('random-with-recent-pair-avoidance'),
    recentPairHistoryLimit: z.literal(3),
    maximumTrackedEligibilityPools: z.literal(64),
    mixedPassagePriority: z.tuple([
      z.literal('long-mixed'),
      z.literal('jumps'),
      z.literal('repeated'),
      z.literal('runs'),
    ]),
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

  rules.methods.forEach((method, methodIndex) => {
    if (
      method.applicability.maximumAttacks !== null
      && method.applicability.maximumAttacks < method.applicability.minimumAttacks
    ) {
      context.addIssue({
        code: 'custom',
        path: ['methods', methodIndex, 'applicability', 'maximumAttacks'],
        message: 'A method applicability maximum cannot be lower than its minimum.',
      });
    }
  });
});

export type OctavePattern = z.infer<typeof OctavePatternSchema>;
export type OctaveMethodId = z.infer<typeof OctaveMethodIdSchema>;
export type OctavePracticeMethod = z.infer<typeof OctaveMethodSchema>;
export type OctavePracticeRules = z.infer<typeof OctavePracticeRulesSchema>;
export type OctaveMethodPair = readonly [OctaveMethodId, OctaveMethodId];

const RULES_URL = new URL('../Practice_Rules/czerny-etude-49-practice-rules.json', import.meta.url);
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
const recentPairsByEligibilityPool = new Map<string, OctaveMethodPair[]>();

export function getOctavePracticeRules(): Readonly<OctavePracticeRules> {
  return OCTAVE_RULES;
}

export function getOctaveRulesFileReadCount(): number {
  return rulesFileReadCount;
}

export function eligibleOctaveMethodIds(
  pattern: OctavePattern,
  attackCount: number,
): readonly OctaveMethodId[] {
  if (!Number.isInteger(attackCount) || attackCount < 1) return [];
  return OCTAVE_RULES.methods.flatMap((method) => {
    const { applicability } = method;
    const patterns: readonly OctavePattern[] = applicability.patterns;
    const excludedPatterns: readonly OctavePattern[] = 'excludePatterns' in applicability
      ? applicability.excludePatterns
      : [];
    return patterns.includes(pattern)
      && !excludedPatterns.includes(pattern)
      && attackCount >= applicability.minimumAttacks
      && (applicability.maximumAttacks === null || attackCount <= applicability.maximumAttacks)
      ? [method.id]
      : [];
  });
}

function availablePairs(methodIds: readonly OctaveMethodId[]): OctaveMethodPair[] {
  return methodIds.flatMap((first, firstIndex) => (
    methodIds.slice(firstIndex + 1).map((second) => [first, second] as const)
  ));
}

function pairKey(pair: OctaveMethodPair): string {
  return pair.join('\u0000');
}

function methodOverlap(first: OctaveMethodPair, second: OctaveMethodPair): number {
  return first.filter((methodId) => second.includes(methodId)).length;
}

function rememberPair(poolKey: string, pair: OctaveMethodPair): void {
  const previous = recentPairsByEligibilityPool.get(poolKey) ?? [];
  const next = [
    pair,
    ...previous.filter((candidate) => pairKey(candidate) !== pairKey(pair)),
  ].slice(0, OCTAVE_RULES.selection.recentPairHistoryLimit);

  recentPairsByEligibilityPool.delete(poolKey);
  recentPairsByEligibilityPool.set(poolKey, next);
  while (
    recentPairsByEligibilityPool.size
    > OCTAVE_RULES.selection.maximumTrackedEligibilityPools
  ) {
    const oldestKey = recentPairsByEligibilityPool.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    recentPairsByEligibilityPool.delete(oldestKey);
  }
}

export function selectOctaveMethodPair(
  pattern: OctavePattern,
  attackCount: number,
): OctaveMethodPair | null {
  const eligibleMethods = eligibleOctaveMethodIds(pattern, attackCount);
  const pairs = availablePairs(eligibleMethods);
  if (pairs.length === 0) return null;

  const poolKey = eligibleMethods.join('\u0000');
  const recentPairs = recentPairsByEligibilityPool.get(poolKey) ?? [];
  const recentPairKeys = new Set(recentPairs.map(pairKey));
  const notRecentlyUsed = pairs.filter((pair) => !recentPairKeys.has(pairKey(pair)));
  let candidates = notRecentlyUsed.length > 0 ? notRecentlyUsed : pairs;

  const latestPair = recentPairs[0];
  if (latestPair && candidates.length > 1) {
    const lowestOverlap = Math.min(...candidates.map((pair) => methodOverlap(pair, latestPair)));
    candidates = candidates.filter((pair) => methodOverlap(pair, latestPair) === lowestOverlap);
  }

  const selected = candidates[randomInt(candidates.length)];
  rememberPair(poolKey, selected);
  return selected;
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

export function octaveSelectionPromptSummary(
  pattern: OctavePattern,
  attackCount: number,
  selectedMethods: OctaveMethodPair,
): Record<string, unknown> | null {
  const eligibleMethods = eligibleOctaveMethodIds(pattern, attackCount);
  if (
    selectedMethods[0] === selectedMethods[1]
    || selectedMethods.some((methodId) => !eligibleMethods.includes(methodId))
  ) return null;

  return {
    rulesVersion: OCTAVE_RULES.schemaVersion,
    ruleSetId: OCTAVE_RULES.id,
    sourceDocument: OCTAVE_RULES.source.document,
    selectionStrategy: OCTAVE_RULES.selection.strategy,
    pattern,
    attackCount,
    methodIds: selectedMethods,
    methods: selectedMethods.map(octaveMethodPromptSummary),
  };
}
