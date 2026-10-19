import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  AIMeasureAnalysisSchema,
  AIPracticeExerciseSchema,
  materializeMeasureAnalysis,
} from './exercise-musicxml.js';
import type { GeneratedMeasureAnalysis } from './exercise-musicxml.js';
import type { ExtractedMeasure } from './measure.js';

export const PRACTICE_TECHNIQUE_IDS = [
  'octaves',
  'chord-jumps',
  'scales-chromatic-runs',
  'arpeggios-broken-chords',
  'single-note-leaps',
  'repeated-notes-chords',
  'double-notes',
  'trills-ornaments',
  'hands-polyrhythms',
  'melody-accompaniment',
] as const;

export const PRACTICE_METHOD_IDS = [
  'octave-finger-lines',
  'octave-dotted-rhythms',
  'octave-secure-landings',
  'octave-release-reset',
  'chord-upper-note-targets',
  'chord-lower-group-targets',
  'scale-short-groups',
  'scale-rhythm-variants',
  'arpeggio-blocked-cells',
  'arpeggio-reduced-landings',
  'leap-departure-arrival-pairs',
  'leap-arrival-targets',
  'repetition-release-reset',
  'repetition-short-groups',
  'double-note-separate-lines',
  'double-note-slow-groups',
  'ornament-slow-alternation',
  'ornament-short-groups',
  'coordination-hands-separately',
  'coordination-timing-skeleton',
  'melody-alone',
  'melody-harmonic-skeleton',
  'general-focused-reduction',
  'general-contrasting-variation',
] as const;

const TechniqueIdSchema = z.enum(PRACTICE_TECHNIQUE_IDS);
const GuidedTechniqueIdSchema = z.enum([...PRACTICE_TECHNIQUE_IDS, 'general']);
const MethodIdSchema = z.enum(PRACTICE_METHOD_IDS);

const MethodNotationSchema = z.object({
  passes: z.array(z.string().trim().min(1).max(80)).min(1).max(3),
  preserveRhythm: z.boolean(),
  preservePitchOrder: z.boolean(),
  requirements: z.array(z.string().trim().min(4).max(240)).min(1).max(8),
}).strict();

const PracticeMethodSchema = z.object({
  id: MethodIdSchema,
  title: z.string().trim().min(2).max(80),
  instructions: z.array(z.string().trim().min(12).max(240)).length(2),
  notation: MethodNotationSchema,
}).strict();

const TechniqueSchema = z.object({
  id: TechniqueIdSchema,
  title: z.string().trim().min(2).max(100),
  detectionEvidence: z.array(z.string().trim().min(12).max(300)).min(1).max(8),
  exclusions: z.array(z.string().trim().min(8).max(300)).max(8),
  firstMethodIds: z.array(MethodIdSchema).min(1).max(4),
  secondMethodIds: z.array(MethodIdSchema).min(1).max(4),
  methods: z.array(PracticeMethodSchema).min(2).max(6),
  guardrails: z.array(z.string().trim().min(8).max(300)).min(1).max(8),
}).strict();

const OctaveDetectionSchema = z.object({
  octaveSemitones: z.literal(12),
  requireSameStepAndAlter: z.literal(true),
  minimumRunAttacks: z.number().int().min(3).max(16),
  maximumRunStepSemitones: z.number().int().min(1).max(6),
  maximumRunOnsetRatio: z.number().min(1).max(4),
  minimumJumpSemitones: z.number().int().min(3).max(12),
  minimumLongPassageAttacks: z.number().int().min(4).max(32),
  minimumRepeatedOrJumpAttacks: z.literal(2),
  onsetToleranceQuarterNotes: z.number().positive().max(0.001),
  durationToleranceQuarterNotes: z.number().positive().max(0.001),
  ignoreIsolatedOctaves: z.literal(true),
  ignoreGraceNotes: z.literal(true),
  ignoreTieStopContinuations: z.literal(true),
}).strict();

const OctaveEngineSchema = z.object({
  detection: OctaveDetectionSchema,
  handRules: z.object({
    inferOnlyFromTwoStaffPianoPart: z.literal(true),
    staffOne: z.literal('right'),
    staffTwo: z.literal('left'),
    rightHand: z.object({
      fingerFivePitch: z.literal('upper'),
      thumbPitch: z.literal('lower'),
    }).strict(),
    leftHand: z.object({
      fingerFivePitch: z.literal('lower'),
      thumbPitch: z.literal('upper'),
    }).strict(),
    oneHandNotation: z.literal('affected-hand-only'),
    bothHandsNotation: z.literal('both-hands-with-aligned-timing'),
    sourceFingeringsTakePriority: z.literal(true),
  }).strict(),
  selection: z.object({
    firstExercise: z.literal('octave-finger-lines'),
    secondExerciseByPattern: z.object({
      runs: z.literal('octave-dotted-rhythms'),
      jumps: z.literal('octave-secure-landings'),
      repeated: z.literal('octave-release-reset'),
      'long-mixed': z.literal('octave-secure-landings'),
    }).strict(),
    mixedPassagePriority: z.tuple([
      z.literal('long-mixed'),
      z.literal('jumps'),
      z.literal('repeated'),
      z.literal('runs'),
    ]),
  }).strict(),
}).strict();

const PracticeGuideSchema = z.object({
  schemaVersion: z.literal(3),
  id: z.literal('expanded-piano-practice-guide'),
  source: z.object({
    document: z.literal('PracticeAI_Expanded_Piano_Practice_Guide.docx'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    treatAsTeachingReferenceOnly: z.literal(true),
    loadDocumentAtRuntime: z.literal(false),
  }).strict(),
  globalSelection: z.object({
    exerciseCount: z.literal(2),
    identifyDominantDifficultyFirst: z.literal(true),
    requireMusicalEvidence: z.literal(true),
    oneAffectedHandOnly: z.literal(true),
    coordinateBothAffectedHands: z.literal(true),
    preserveTiedAndSustainedVoices: z.literal(true),
    fallbackTechniqueId: z.literal('general'),
  }).strict(),
  globalNotation: z.object({
    markAsPracticeVersion: z.literal(true),
    preservePitchSpelling: z.literal(true),
    preserveAccidentals: z.literal(true),
    preserveRegister: z.literal(true),
    preserveRelevantEventOrder: z.literal(true),
    recalculateDurationsAndRests: z.literal(true),
    useLegalPracticeMeter: z.literal(true),
    validateMusicXmlBeforeDisplay: z.literal(true),
    instructionSentencesPerExercise: z.literal(2),
    doNotModifySourceMusicXml: z.literal(true),
  }).strict(),
  safety: z.object({
    stopForPainOrTension: z.literal(true),
    doNotForceWideBlockedShapes: z.literal(true),
    doNotInventFingerings: z.literal(true),
    doNotInventOrnamentPitches: z.literal(true),
    historicalMethodsAreReferences: z.literal(true),
  }).strict(),
  implementationDefaults: z.object({
    description: z.string().trim().min(20).max(300),
    minimumChordJumpTravelSemitones: z.number().int().min(1).max(24),
    minimumSingleNoteLeapSemitones: z.number().int().min(1).max(24),
    maximumRapidNoteDurationQuarterNotes: z.number().positive().max(2),
    maximumScaleStepSemitones: z.number().int().min(1).max(6),
    minimumRepeatedAttacks: z.number().int().min(2).max(16),
    maximumComfortableBlockedSpanSemitones: z.number().int().min(7).max(24),
    scaleGroupSize: z.number().int().min(2).max(6),
    arpeggioCellSize: z.number().int().min(2).max(8),
    dominancePriority: z.array(TechniqueIdSchema).length(PRACTICE_TECHNIQUE_IDS.length),
    handInference: z.string().trim().min(20).max(400),
  }).strict(),
  octaveEngine: OctaveEngineSchema,
  techniques: z.array(TechniqueSchema).length(PRACTICE_TECHNIQUE_IDS.length),
  fallback: z.object({
    id: z.literal('general'),
    title: z.string().trim().min(2).max(100),
    firstMethodIds: z.array(MethodIdSchema).length(1),
    secondMethodIds: z.array(MethodIdSchema).length(1),
    methods: z.array(PracticeMethodSchema).length(2),
  }).strict(),
}).strict().superRefine((rules, context) => {
  const techniqueIds = rules.techniques.map((technique) => technique.id);
  if (
    new Set(techniqueIds).size !== PRACTICE_TECHNIQUE_IDS.length
    || PRACTICE_TECHNIQUE_IDS.some((id) => !techniqueIds.includes(id))
  ) {
    context.addIssue({ code: 'custom', message: 'The expanded guide must define every supported technique exactly once.' });
  }

  const methods = [...rules.techniques.flatMap((technique) => technique.methods), ...rules.fallback.methods];
  const methodIds = methods.map((method) => method.id);
  if (
    new Set(methodIds).size !== PRACTICE_METHOD_IDS.length
    || PRACTICE_METHOD_IDS.some((id) => !methodIds.includes(id))
  ) {
    context.addIssue({ code: 'custom', message: 'The expanded guide must define every practice method exactly once.' });
  }

  for (const technique of rules.techniques) {
    const localIds = new Set(technique.methods.map((method) => method.id));
    for (const methodId of [...technique.firstMethodIds, ...technique.secondMethodIds]) {
      if (!localIds.has(methodId)) {
        context.addIssue({ code: 'custom', message: `${technique.id} selects a method it does not define.` });
      }
    }
  }

  const priority = rules.implementationDefaults.dominancePriority;
  if (new Set(priority).size !== PRACTICE_TECHNIQUE_IDS.length) {
    context.addIssue({ code: 'custom', message: 'The dominance priority must contain each supported technique once.' });
  }
});

export type PracticeTechniqueId = z.infer<typeof TechniqueIdSchema>;
export type GuidedTechniqueId = z.infer<typeof GuidedTechniqueIdSchema>;
export type PracticeMethodId = z.infer<typeof MethodIdSchema>;
export type PracticeGuideRules = z.infer<typeof PracticeGuideSchema>;
type PracticeMethod = z.infer<typeof PracticeMethodSchema>;

const GuidedExerciseSchema = AIPracticeExerciseSchema.extend({
  methodId: MethodIdSchema.describe('The exact method identifier selected from the trusted practice guide.'),
}).strict();

export const AIGuidedMeasureAnalysisSchema = z.object({
  analysis: z.string().trim().min(1).max(6_000),
  techniqueId: GuidedTechniqueIdSchema,
  exercises: z.array(GuidedExerciseSchema).length(2),
}).strict();

export type AIGuidedMeasureAnalysisPlan = z.infer<typeof AIGuidedMeasureAnalysisSchema>;

export interface PracticeGuideContext {
  rulesVersion: number;
  ruleSetId: string;
}

const RULES_URL = new URL('../Practice_Rules/piano-practice-rules.json', import.meta.url);
let rulesFileReadCount = 0;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function loadRulesOnce(): Readonly<PracticeGuideRules> {
  rulesFileReadCount += 1;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(RULES_URL, 'utf8'));
  } catch (error) {
    throw new Error('The expanded piano practice rules could not be loaded.', { cause: error });
  }
  const parsed = PracticeGuideSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`The expanded piano practice rules are invalid: ${z.prettifyError(parsed.error)}`);
  }
  return deepFreeze(parsed.data);
}

const PRACTICE_RULES = loadRulesOnce();

export function getPracticeGuideRules(): Readonly<PracticeGuideRules> {
  return PRACTICE_RULES;
}

export function getPracticeGuideRulesFileReadCount(): number {
  return rulesFileReadCount;
}

export function getPracticeGuideContext(): PracticeGuideContext {
  return {
    rulesVersion: PRACTICE_RULES.schemaVersion,
    ruleSetId: PRACTICE_RULES.id,
  };
}

function methodSummary(method: PracticeMethod): Record<string, unknown> {
  return {
    id: method.id,
    title: method.title,
    instructions: method.instructions,
    passes: method.notation.passes,
    preserveRhythm: method.notation.preserveRhythm,
    preservePitchOrder: method.notation.preservePitchOrder,
    requirements: method.notation.requirements,
  };
}

export function practiceGuidePromptSummary(): Record<string, unknown> {
  return {
    rulesVersion: PRACTICE_RULES.schemaVersion,
    ruleSetId: PRACTICE_RULES.id,
    globalSelection: PRACTICE_RULES.globalSelection,
    globalNotation: PRACTICE_RULES.globalNotation,
    safety: PRACTICE_RULES.safety,
    implementationDefaults: PRACTICE_RULES.implementationDefaults,
    techniques: PRACTICE_RULES.techniques.map((technique) => ({
      id: technique.id,
      title: technique.title,
      detectionEvidence: technique.detectionEvidence,
      exclusions: technique.exclusions,
      firstMethodIds: technique.firstMethodIds,
      secondMethodIds: technique.secondMethodIds,
      methods: technique.methods.map(methodSummary),
      guardrails: technique.guardrails,
    })),
    fallback: {
      id: PRACTICE_RULES.fallback.id,
      firstMethodIds: PRACTICE_RULES.fallback.firstMethodIds,
      secondMethodIds: PRACTICE_RULES.fallback.secondMethodIds,
      methods: PRACTICE_RULES.fallback.methods.map(methodSummary),
    },
  };
}

export function getOctaveEngineRules() {
  const octave = PRACTICE_RULES.techniques.find((technique) => technique.id === 'octaves');
  if (!octave) throw new Error('The expanded guide is missing its octave technique.');
  const patternsByMethod: Record<string, Array<'runs' | 'jumps' | 'repeated' | 'long-mixed'>> = {
    'octave-finger-lines': ['runs', 'jumps', 'repeated', 'long-mixed'],
    'octave-dotted-rhythms': ['runs'],
    'octave-secure-landings': ['jumps', 'long-mixed'],
    'octave-release-reset': ['repeated'],
  };
  return deepFreeze({
    schemaVersion: PRACTICE_RULES.schemaVersion,
    detection: PRACTICE_RULES.octaveEngine.detection,
    selection: PRACTICE_RULES.octaveEngine.selection,
    methods: octave.methods.map((method) => ({
      id: method.id,
      patterns: patternsByMethod[method.id],
      title: method.title,
      sentenceTemplates: method.instructions,
      notation: {
        passes: method.notation.passes,
        preserveRhythm: method.notation.preserveRhythm,
        preservePitchOrder: method.notation.preservePitchOrder,
        showFingerings: true as const,
      },
    })),
  });
}

function invalidGuidedResponse(message = 'OpenAI selected practice methods that do not match the expanded guide.'): AppError {
  return new AppError(502, 'OPENAI_INVALID_RESPONSE', message);
}

function selectedTechnique(plan: AIGuidedMeasureAnalysisPlan) {
  if (plan.techniqueId === 'general') return PRACTICE_RULES.fallback;
  return PRACTICE_RULES.techniques.find((technique) => technique.id === plan.techniqueId);
}

function pitchKey(pitch: { step: string; alter?: number; octave: number }): string {
  return `${pitch.step}:${pitch.alter ?? 0}:${pitch.octave}`;
}

function sourcePitchKeys(measure: ExtractedMeasure): Set<string> {
  const keys = new Set<string>();
  for (const part of measure.parts) {
    for (const event of part.events) {
      if (event.kind !== 'note' || !event.pitch || typeof event.pitch !== 'object') continue;
      const pitch = event.pitch as Record<string, unknown>;
      if (typeof pitch.step !== 'string' || typeof pitch.octave !== 'number') continue;
      keys.add(pitchKey({
        step: pitch.step,
        alter: typeof pitch.alter === 'number' ? pitch.alter : 0,
        octave: pitch.octave,
      }));
    }
  }
  return keys;
}

function validateExactSourcePitches(plan: AIGuidedMeasureAnalysisPlan, measure: ExtractedMeasure): void {
  if (plan.techniqueId === 'general') return;
  const source = sourcePitchKeys(measure);
  for (const exercise of plan.exercises) {
    for (const staff of exercise.notation.staves) {
      for (const event of staff.events) {
        for (const pitch of event.pitches) {
          if (!source.has(pitchKey(pitch))) {
            throw invalidGuidedResponse('A guided exercise contained a pitch or register that is not in the selected measure.');
          }
        }
      }
    }
  }
}

export function materializeGuidedMeasureAnalysis(
  plan: AIGuidedMeasureAnalysisPlan,
  sourceMeasure: ExtractedMeasure,
): GeneratedMeasureAnalysis {
  const technique = selectedTechnique(plan);
  if (!technique) throw invalidGuidedResponse();
  const [first, second] = plan.exercises;
  if (
    first.methodId === second.methodId
    || !technique.firstMethodIds.includes(first.methodId)
    || !technique.secondMethodIds.includes(second.methodId)
  ) {
    throw invalidGuidedResponse();
  }
  validateExactSourcePitches(plan, sourceMeasure);
  const basePlan = AIMeasureAnalysisSchema.parse({
    analysis: plan.analysis,
    exercises: plan.exercises.map(({ methodId: _methodId, ...exercise }) => exercise),
  });
  return materializeMeasureAnalysis(basePlan, sourceMeasure);
}
