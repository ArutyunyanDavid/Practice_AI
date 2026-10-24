import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const CZERNY50_SCORE_FILENAME = 'Czerny_etude_50.mscz' as const;

export const CZERNY50_METHOD_IDS = [
  'dotted-rhythmic-pairs',
  'four-fast-four-slow',
  'two-fast-two-slow',
  'long-note-outside',
  'long-note-inside',
  'long-notes-outside-inside',
] as const;

export const CZERNY50_DURATION_IDS = [
  'sixteenth',
  'eighth',
  'dotted-eighth',
] as const;

const Czerny50MethodIdSchema = z.enum(CZERNY50_METHOD_IDS);
const Czerny50DurationIdSchema = z.enum(CZERNY50_DURATION_IDS);

function isSimpleSentence(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized.endsWith('.') || normalized.includes(';')) return false;
  if (/[.!?]/.test(normalized.slice(0, -1))) return false;
  const wordCount = normalized.slice(0, -1).split(' ').filter(Boolean).length;
  return wordCount >= 3 && wordCount <= 20;
}

const SimpleSentenceSchema = z.string().trim().min(8).max(220).refine(
  isSimpleSentence,
  'Each instruction must be one simple sentence ending in a period.',
);

const MethodSchema = z.object({
  id: Czerny50MethodIdSchema,
  exerciseNumber: z.number().int().min(1).max(6),
  title: z.string().trim().min(3).max(64),
  summary: z.string().trim().min(12).max(180),
  meter: z.object({
    beats: z.union([z.literal(3), z.literal(4), z.literal(6)]),
    beatType: z.union([z.literal(4), z.literal(8)]),
  }).strict(),
  firstMeasureDurations: z.array(Czerny50DurationIdSchema).length(8),
  secondMeasureDurations: z.array(Czerny50DurationIdSchema).length(8),
  instructionSentences: z.tuple([SimpleSentenceSchema, SimpleSentenceSchema]),
  directionAboveExercise: z.string().trim().min(12).max(300).nullable(),
}).strict();

const Czerny50PracticeRulesSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.literal('czerny-etude-50-practice-rules'),
  source: z.object({
    document: z.literal('Czerny_etude_50.docx'),
    sha256: z.literal('991cac369d843909779cbb34c1d5ad2dfade36981000af5546a66e14f5aef463'),
    treatAsTeachingReferenceOnly: z.literal(true),
    loadDocumentAtRuntime: z.literal(false),
  }).strict(),
  scope: z.object({
    scoreFilename: z.literal(CZERNY50_SCORE_FILENAME),
    passageNoteCount: z.literal(8),
    exerciseCount: z.literal(2),
  }).strict(),
  detection: z.object({
    groupByPartStaffAndVoice: z.literal(true),
    requireContiguousMonophonicNotes: z.literal(true),
    ignoreGraceNotes: z.literal(true),
    ignoreTieStopContinuations: z.literal(true),
    ignoreChordAttacks: z.literal(true),
    staffOneHand: z.literal('right'),
    staffTwoHand: z.literal('left'),
  }).strict(),
  notation: z.object({
    measureCountPerExercise: z.literal(2),
    preservePitchSpelling: z.literal(true),
    preserveRegister: z.literal(true),
    preservePitchOrder: z.literal(true),
    useSourceKey: z.literal(true),
    useSourceStaffClef: z.literal(true),
    instructionSentencesPerExercise: z.literal(2),
    validateMusicXmlBeforeDisplay: z.literal(true),
  }).strict(),
  methods: z.array(MethodSchema).length(CZERNY50_METHOD_IDS.length),
}).strict().superRefine((rules, context) => {
  const ids = rules.methods.map((method) => method.id);
  if (
    new Set(ids).size !== CZERNY50_METHOD_IDS.length
    || CZERNY50_METHOD_IDS.some((methodId) => !ids.includes(methodId))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['methods'],
      message: 'The Czerny rules must define all six methods exactly once.',
    });
  }

  const durationTicks: Record<Czerny50DurationId, number> = {
    sixteenth: 1,
    eighth: 2,
    'dotted-eighth': 3,
  };
  rules.methods.forEach((method, index) => {
    if (method.exerciseNumber !== index + 1 || method.id !== CZERNY50_METHOD_IDS[index]) {
      context.addIssue({
        code: 'custom',
        path: ['methods', index],
        message: 'Czerny methods must remain in the document order.',
      });
    }
    const expectedTicks = method.meter.beats * (16 / method.meter.beatType);
    for (const [field, durations] of [
      ['firstMeasureDurations', method.firstMeasureDurations],
      ['secondMeasureDurations', method.secondMeasureDurations],
    ] as const) {
      const actualTicks = durations.reduce((sum, duration) => sum + durationTicks[duration], 0);
      if (actualTicks !== expectedTicks) {
        context.addIssue({
          code: 'custom',
          path: ['methods', index, field],
          message: 'The duration pattern must exactly fill its documented meter.',
        });
      }
    }
  });
});

export type Czerny50DurationId = z.infer<typeof Czerny50DurationIdSchema>;
export type Czerny50MethodId = z.infer<typeof Czerny50MethodIdSchema>;
export type Czerny50PracticeMethod = z.infer<typeof MethodSchema>;
export type Czerny50PracticeRules = z.infer<typeof Czerny50PracticeRulesSchema>;

const RULES_URL = new URL('../Practice_Rules/czerny-etude-50-practice-rules.json', import.meta.url);
let rulesFileReadCount = 0;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

function loadRulesOnce(): Readonly<Czerny50PracticeRules> {
  rulesFileReadCount += 1;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(RULES_URL, 'utf8'));
  } catch (error) {
    throw new Error('The Czerny Etude No. 50 practice rules could not be loaded.', { cause: error });
  }
  const parsed = Czerny50PracticeRulesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`The Czerny Etude No. 50 practice rules are invalid: ${z.prettifyError(parsed.error)}`);
  }
  return deepFreeze(parsed.data);
}

const CZERNY50_RULES = loadRulesOnce();

export function getCzerny50PracticeRules(): Readonly<Czerny50PracticeRules> {
  return CZERNY50_RULES;
}

export function getCzerny50RulesFileReadCount(): number {
  return rulesFileReadCount;
}

export function getCzerny50Method(methodId: Czerny50MethodId): Readonly<Czerny50PracticeMethod> {
  const method = CZERNY50_RULES.methods.find((candidate) => candidate.id === methodId);
  if (!method) throw new Error(`Unknown Czerny Etude No. 50 method: ${methodId}`);
  return method;
}
