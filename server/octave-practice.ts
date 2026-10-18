import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AppError } from './errors.js';
import { extractMeasureForAnalysis } from './measure.js';
import type { ExtractedMeasure, ExtractedMeasurePart } from './measure.js';
import type { GeneratedMeasureAnalysis, GeneratedPracticeExercise } from './exercise-musicxml.js';
import { assertMusicXml } from './xml.js';

const HandSchema = z.enum(['right', 'left']);
const PatternSchema = z.enum(['runs', 'jumps', 'repeated', 'long-mixed']);
const MethodIdSchema = z.enum([
  'separate-finger-lines',
  'dotted-rhythm-variations',
  'secure-landings',
  'release-and-reset',
  'short-groups',
]);

const NotationRuleSchema = z.object({
  passes: z.array(z.string().trim().min(1).max(40)).min(1).max(2),
  preserveRhythm: z.boolean(),
  preservePitchOrder: z.literal(true),
  showFingerings: z.literal(true),
}).strict();

const MethodSchema = z.object({
  id: MethodIdSchema,
  patterns: z.array(PatternSchema).min(1).max(4),
  title: z.string().trim().min(2).max(80),
  sentenceTemplates: z.array(z.string().trim().min(12).max(240)).length(2),
  notation: NotationRuleSchema,
}).strict();

const OctaveRulesSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.literal('octave-practice-guide'),
  source: z.object({
    document: z.literal('Octave_Practice_Guide.docx'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    treatAsTeachingReferenceOnly: z.literal(true),
    loadDocumentAtRuntime: z.literal(false),
  }).strict(),
  implementationDefaults: z.object({
    description: z.string().trim().min(20).max(300),
    paths: z.array(z.string().trim().min(3).max(100)).min(1).max(32),
  }).strict(),
  principles: z.object({
    matchExerciseToProblem: z.literal(true),
    workSlowly: z.literal(true),
    stopWhenTense: z.literal(true),
    returnToOriginalMeasureAfterDrill: z.literal(true),
    restoreOriginalRhythm: z.literal(true),
    restoreOriginalArticulation: z.literal(true),
    restoreOriginalMusicalCharacter: z.literal(true),
    preserveSourcePitchSpellingAndOrder: z.literal(true),
    omitIrrelevantAccompaniment: z.literal(true),
  }).strict(),
  detection: z.object({
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
  }).strict(),
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
  }).strict(),
  selection: z.object({
    firstExercise: z.literal('separate-finger-lines'),
    secondExerciseByPattern: z.object({
      runs: z.literal('dotted-rhythm-variations'),
      jumps: z.literal('secure-landings'),
      repeated: z.literal('release-and-reset'),
      'long-mixed': z.literal('short-groups'),
    }).strict(),
    mixedPassagePriority: z.array(PatternSchema).length(4),
  }).strict(),
  methods: z.array(MethodSchema).length(5),
}).strict().superRefine((rules, context) => {
  const methodIds = rules.methods.map((method) => method.id);
  if (new Set(methodIds).size !== methodIds.length) {
    context.addIssue({ code: 'custom', message: 'Octave methods must have unique IDs.' });
  }
  for (const required of MethodIdSchema.options) {
    if (!methodIds.includes(required)) {
      context.addIssue({ code: 'custom', message: `Missing octave method ${required}.` });
    }
  }
  if (new Set(rules.selection.mixedPassagePriority).size !== PatternSchema.options.length) {
    context.addIssue({ code: 'custom', message: 'Pattern priority must contain each pattern once.' });
  }
});

export const AIOctaveAnalysisSchema = z.object({
  analysis: z.string().trim().min(1).max(6_000)
    .describe('A focused analysis of the detected octave difficulty, affected hand or hands, coordination, movement, tension risk, and musical context grounded only in the supplied measure.'),
}).strict();

export type OctaveHand = z.infer<typeof HandSchema>;
export type OctavePattern = z.infer<typeof PatternSchema>;
export type OctaveMethodId = z.infer<typeof MethodIdSchema>;
type OctaveRules = z.infer<typeof OctaveRulesSchema>;
type OctaveMethod = z.infer<typeof MethodSchema>;

export interface OctavePitch {
  step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  alter: number;
  octave: number;
  midi: number;
}

interface TimeModification {
  actualNotes: number;
  normalNotes: number;
  normalType?: string;
  normalDots?: number;
}

interface SourceWrittenDuration {
  ticks: number;
  type: string;
  dots: number;
  timeModification?: TimeModification;
}

export interface OctaveAttack {
  partId: string;
  sourceStaff: 1 | 2;
  voice: string;
  hand: OctaveHand;
  onsetQuarterNotes: number;
  durationQuarterNotes: number;
  lower: OctavePitch;
  upper: OctavePitch;
  writtenDuration: SourceWrittenDuration;
}

export interface OctaveHandSequence {
  hand: OctaveHand;
  sourceStaff: 1 | 2;
  voice: string;
  attacks: OctaveAttack[];
  pattern: OctavePattern;
  repeatedTransitions: number;
  jumpTransitions: number;
}

export interface OctavePracticeContext {
  rulesVersion: number;
  partId: string;
  partName: string;
  pattern: OctavePattern;
  affectedHands: OctaveHand[];
  sequences: OctaveHandSequence[];
  selectedMethods: [OctaveMethodId, OctaveMethodId];
}

const RULES_URL = new URL('../Practice_Rules/octave-practice-rules.json', import.meta.url);
let rulesFileReadCount = 0;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function loadRulesOnce(): Readonly<OctaveRules> {
  rulesFileReadCount += 1;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(RULES_URL, 'utf8'));
  } catch (error) {
    throw new Error('The extracted octave practice rules could not be loaded.', { cause: error });
  }
  const parsed = OctaveRulesSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error('The extracted octave practice rules are invalid.', { cause: parsed.error });
  }
  return deepFreeze(parsed.data);
}

const OCTAVE_RULES = loadRulesOnce();

export function getOctavePracticeRules(): Readonly<OctaveRules> {
  return OCTAVE_RULES;
}

export function getOctaveRulesFileReadCount(): number {
  return rulesFileReadCount;
}

const TICKS_PER_QUARTER = 48;
const MAX_XML_BYTES = 256 * 1024;
const STEP_SEMITONES: Record<OctavePitch['step'], number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const ALLOWED_NOTE_TYPES = new Set([
  'maxima', 'long', 'breve', 'whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th', '128th', '256th', '512th', '1024th',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function midiNumber(pitch: Omit<OctavePitch, 'midi'>): number {
  return (pitch.octave + 1) * 12 + STEP_SEMITONES[pitch.step] + pitch.alter;
}

function parsePitch(value: unknown): OctavePitch | null {
  const pitch = asRecord(value);
  const step = pitch?.step;
  const alter = pitch?.alter ?? 0;
  const octave = pitch?.octave;
  if (
    typeof step !== 'string'
    || !(step in STEP_SEMITONES)
    || !Number.isInteger(alter)
    || Number(alter) < -2
    || Number(alter) > 2
    || !Number.isInteger(octave)
  ) {
    return null;
  }
  const normalized = {
    step: step as OctavePitch['step'],
    alter: Number(alter),
    octave: Number(octave),
  };
  const midi = midiNumber(normalized);
  if (midi < 21 || midi > 108) return null;
  return { ...normalized, midi };
}

function tieStopsAttack(event: Record<string, unknown>): boolean {
  return asRecordArray(event.ties).some((tie) => {
    const attributes = asRecord(tie.attributes);
    return attributes?.type === 'stop';
  });
}

function writtenDuration(event: Record<string, unknown>, durationQuarterNotes: number): SourceWrittenDuration {
  const type = typeof event.type === 'string' && ALLOWED_NOTE_TYPES.has(event.type)
    ? event.type
    : 'quarter';
  const dots = Number.isInteger(event.dots) && Number(event.dots) >= 0 && Number(event.dots) <= 3
    ? Number(event.dots)
    : 0;
  const modification = asRecord(event.timeModification);
  const actualNotes = finiteNumber(modification?.actualNotes);
  const normalNotes = finiteNumber(modification?.normalNotes);
  const timeModification = actualNotes && normalNotes
    && Number.isInteger(actualNotes) && Number.isInteger(normalNotes)
    && actualNotes >= 2 && actualNotes <= 16 && normalNotes >= 1 && normalNotes <= 16
    ? {
        actualNotes,
        normalNotes,
        ...(typeof modification?.normalType === 'string' && ALLOWED_NOTE_TYPES.has(modification.normalType)
          ? { normalType: modification.normalType }
          : {}),
        ...(Number.isInteger(modification?.normalDots) && Number(modification?.normalDots) >= 0
          ? { normalDots: Math.min(3, Number(modification?.normalDots)) }
          : {}),
      }
    : undefined;
  return {
    ticks: Math.max(1, Math.round(durationQuarterNotes * TICKS_PER_QUARTER)),
    type,
    dots,
    ...(timeModification ? { timeModification } : {}),
  };
}

interface CandidateNote {
  pitch: OctavePitch;
  durationQuarterNotes: number;
  event: Record<string, unknown>;
}

function partSupportsHandInference(part: ExtractedMeasurePart, onlyScorePart: boolean): boolean {
  const currentAttributes = part.events.find((event) => event.kind === 'attributes');
  const declaredStaves = finiteNumber(currentAttributes?.staves) ?? finiteNumber(part.startingContext.staves);
  const pianoNamed = /(?:piano|pno\.?|keyboard)/i.test(part.name);
  return declaredStaves === 2 && (pianoNamed || onlyScorePart);
}

function sequencePattern(attacks: OctaveAttack[]): {
  pattern: OctavePattern | null;
  repeatedTransitions: number;
  jumpTransitions: number;
} {
  if (attacks.length < OCTAVE_RULES.detection.minimumRepeatedOrJumpAttacks) {
    return { pattern: null, repeatedTransitions: 0, jumpTransitions: 0 };
  }
  const intervals = attacks.slice(1).map((attack, index) => (
    attack.lower.midi - attacks[index].lower.midi
  ));
  const repeatedTransitions = intervals.filter((interval) => interval === 0).length;
  const jumpTransitions = intervals.filter((interval) => (
    Math.abs(interval) >= OCTAVE_RULES.detection.minimumJumpSemitones
  )).length;
  const isRun = attacks.length >= OCTAVE_RULES.detection.minimumRunAttacks
    && intervals.every((interval) => (
      Math.abs(interval) >= 1
      && Math.abs(interval) <= OCTAVE_RULES.detection.maximumRunStepSemitones
    ));
  const onsetIntervals = attacks.slice(1).map((attack, index) => (
    attack.onsetQuarterNotes - attacks[index].onsetQuarterNotes
  ));
  const regularOnsets = onsetIntervals.every((interval) => interval > 0)
    && Math.max(...onsetIntervals) / Math.min(...onsetIntervals)
      <= OCTAVE_RULES.detection.maximumRunOnsetRatio;
  const mixedKinds = [repeatedTransitions > 0, jumpTransitions > 0, isRun].filter(Boolean).length;

  if (attacks.length >= OCTAVE_RULES.detection.minimumLongPassageAttacks && mixedKinds > 1) {
    return { pattern: 'long-mixed', repeatedTransitions, jumpTransitions };
  }
  if (repeatedTransitions > 0 && repeatedTransitions >= Math.ceil(intervals.length / 2)) {
    return { pattern: 'repeated', repeatedTransitions, jumpTransitions };
  }
  if (jumpTransitions > 0) return { pattern: 'jumps', repeatedTransitions, jumpTransitions };
  if (isRun && regularOnsets) return { pattern: 'runs', repeatedTransitions, jumpTransitions };
  if (attacks.length >= OCTAVE_RULES.detection.minimumLongPassageAttacks) {
    return { pattern: 'long-mixed', repeatedTransitions, jumpTransitions };
  }
  if (repeatedTransitions > 0) return { pattern: 'repeated', repeatedTransitions, jumpTransitions };
  return { pattern: null, repeatedTransitions, jumpTransitions };
}

function attacksForPart(part: ExtractedMeasurePart): OctaveAttack[] {
  const groups = new Map<string, CandidateNote[]>();
  for (const event of part.events) {
    if (
      event.kind !== 'note'
      || event.rest
      || event.grace
      || tieStopsAttack(event)
    ) {
      continue;
    }
    const pitch = parsePitch(event.pitch);
    const onset = finiteNumber(event.onsetQuarterNotes);
    const duration = finiteNumber(event.durationQuarterNotes);
    const staff = finiteNumber(event.staff);
    const voice = typeof event.voice === 'string' ? event.voice : String(event.voice ?? '1');
    if (!pitch || onset === null || duration === null || duration <= 0 || (staff !== 1 && staff !== 2)) continue;
    const onsetKey = Math.round(onset / OCTAVE_RULES.detection.onsetToleranceQuarterNotes);
    const key = `${staff}\u0000${voice}\u0000${onsetKey}`;
    const notes = groups.get(key) ?? [];
    notes.push({ pitch, durationQuarterNotes: duration, event });
    groups.set(key, notes);
  }

  const attacks: OctaveAttack[] = [];
  for (const [key, notes] of groups) {
    if (notes.length < 2 || notes.filter((note) => !note.event.chord).length !== 1) continue;
    const sorted = [...notes].sort((first, second) => first.pitch.midi - second.pitch.midi);
    const lower = sorted[0];
    const upper = sorted[sorted.length - 1];
    if (
      upper.pitch.midi - lower.pitch.midi !== OCTAVE_RULES.detection.octaveSemitones
      || lower.pitch.step !== upper.pitch.step
      || lower.pitch.alter !== upper.pitch.alter
      || upper.pitch.octave - lower.pitch.octave !== 1
      || Math.abs(lower.durationQuarterNotes - upper.durationQuarterNotes)
        > OCTAVE_RULES.detection.durationToleranceQuarterNotes
    ) {
      continue;
    }
    const [staffText, voice] = key.split('\u0000');
    const sourceStaff = Number(staffText) as 1 | 2;
    const onset = finiteNumber(lower.event.onsetQuarterNotes)!;
    attacks.push({
      partId: part.id,
      sourceStaff,
      voice,
      hand: sourceStaff === 1 ? 'right' : 'left',
      onsetQuarterNotes: onset,
      durationQuarterNotes: lower.durationQuarterNotes,
      lower: lower.pitch,
      upper: upper.pitch,
      writtenDuration: writtenDuration(lower.event, lower.durationQuarterNotes),
    });
  }
  return attacks.sort((first, second) => (
    first.onsetQuarterNotes - second.onsetQuarterNotes
    || first.sourceStaff - second.sourceStaff
    || first.voice.localeCompare(second.voice)
  ));
}

function bestSequencesForPart(part: ExtractedMeasurePart): OctaveHandSequence[] {
  const attacks = attacksForPart(part);
  const byVoice = new Map<string, OctaveAttack[]>();
  for (const attack of attacks) {
    const key = `${attack.sourceStaff}|${attack.voice}`;
    const sequence = byVoice.get(key) ?? [];
    sequence.push(attack);
    byVoice.set(key, sequence);
  }

  const candidates: OctaveHandSequence[] = [];
  for (const sequenceAttacks of byVoice.values()) {
    const classification = sequencePattern(sequenceAttacks);
    if (!classification.pattern) continue;
    candidates.push({
      hand: sequenceAttacks[0].hand,
      sourceStaff: sequenceAttacks[0].sourceStaff,
      voice: sequenceAttacks[0].voice,
      attacks: sequenceAttacks,
      pattern: classification.pattern,
      repeatedTransitions: classification.repeatedTransitions,
      jumpTransitions: classification.jumpTransitions,
    });
  }

  return HandSchema.options.flatMap((hand) => {
    const handCandidates = candidates.filter((candidate) => candidate.hand === hand);
    handCandidates.sort((first, second) => (
      second.attacks.length - first.attacks.length
      || OCTAVE_RULES.selection.mixedPassagePriority.indexOf(first.pattern)
        - OCTAVE_RULES.selection.mixedPassagePriority.indexOf(second.pattern)
      || first.voice.localeCompare(second.voice)
    ));
    return handCandidates.slice(0, 1);
  });
}

function overallPattern(sequences: OctaveHandSequence[]): OctavePattern {
  const patterns = new Set(sequences.map((sequence) => sequence.pattern));
  const attackCount = sequences.reduce((total, sequence) => total + sequence.attacks.length, 0);
  if (patterns.size > 1 && attackCount >= OCTAVE_RULES.detection.minimumLongPassageAttacks) {
    return 'long-mixed';
  }
  if (patterns.size === 1) return sequences[0].pattern;
  return [...patterns].sort((first, second) => (
    OCTAVE_RULES.selection.mixedPassagePriority.indexOf(first)
      - OCTAVE_RULES.selection.mixedPassagePriority.indexOf(second)
  ))[0];
}

export function detectOctavePassage(measure: ExtractedMeasure): OctavePracticeContext | null {
  const candidates = measure.parts
    .filter((part) => partSupportsHandInference(part, measure.parts.length === 1))
    .map((part) => ({ part, sequences: bestSequencesForPart(part) }))
    .filter((candidate) => candidate.sequences.length > 0)
    .sort((first, second) => (
      second.sequences.reduce((sum, sequence) => sum + sequence.attacks.length, 0)
        - first.sequences.reduce((sum, sequence) => sum + sequence.attacks.length, 0)
      || first.part.id.localeCompare(second.part.id)
    ));
  const selected = candidates[0];
  if (!selected) return null;

  const pattern = overallPattern(selected.sequences);
  const secondMethod = OCTAVE_RULES.selection.secondExerciseByPattern[pattern];
  return {
    rulesVersion: OCTAVE_RULES.schemaVersion,
    partId: selected.part.id,
    partName: selected.part.name,
    pattern,
    affectedHands: selected.sequences.map((sequence) => sequence.hand),
    sequences: selected.sequences.map((sequence) => ({
      ...sequence,
      attacks: [...sequence.attacks],
    })),
    selectedMethods: [OCTAVE_RULES.selection.firstExercise, secondMethod],
  };
}

export function octavePracticePromptSummary(context: OctavePracticeContext): Record<string, unknown> {
  return {
    rulesVersion: context.rulesVersion,
    detectedPattern: context.pattern,
    affectedHands: context.affectedHands,
    selectedMethods: context.selectedMethods,
    handSequences: context.sequences.map((sequence) => ({
      hand: sequence.hand,
      attackCount: sequence.attacks.length,
      pattern: sequence.pattern,
      repeatedTransitions: sequence.repeatedTransitions,
      jumpTransitions: sequence.jumpTransitions,
      octavePitches: sequence.attacks.map((attack) => ({
        onsetQuarterNotes: attack.onsetQuarterNotes,
        lower: { step: attack.lower.step, alter: attack.lower.alter, octave: attack.lower.octave },
        upper: { step: attack.upper.step, alter: attack.upper.alter, octave: attack.upper.octave },
      })),
    })),
    teachingReference: {
      firstExercise: 'Play the fifth-finger pitch line first and the thumb pitch line second, preserving source order and rhythm.',
      secondExercise: context.selectedMethods[1],
      safety: 'Work slowly, stay relaxed, stop if tension appears, and after every drill return to the original measure with its real rhythm, articulation, and musical character.',
    },
  };
}

interface DrillDuration {
  ticks: number;
  type: string;
  dots?: number;
  timeModification?: TimeModification;
}

interface DrillEvent {
  onsetTicks: number;
  duration: DrillDuration;
  pitches: OctavePitch[];
  fingerings: Array<1 | 5>;
  rest?: boolean;
  articulation?: 'staccato';
}

interface DrillStaff {
  hand: OctaveHand;
  number: number;
  clef: 'treble' | 'bass';
  events: DrillEvent[];
}

interface DrillMeasure {
  label: string;
  staves: DrillStaff[];
}

interface ExpectedNote {
  staff: number;
  onsetTicks: number;
  durationTicks: number;
  pitch: { step: string; alter: number; octave: number } | null;
  chord: boolean;
  fingering: string | null;
}

const DOTTED_EIGHTH: DrillDuration = { ticks: 36, type: 'eighth', dots: 1 };
const SIXTEENTH: DrillDuration = { ticks: 12, type: '16th' };
const QUARTER: DrillDuration = { ticks: 48, type: 'quarter' };
const EIGHTH: DrillDuration = { ticks: 24, type: 'eighth' };

function invalidOctaveExercise(cause?: unknown): AppError {
  return new AppError(
    500,
    'OCTAVE_EXERCISE_INVALID',
    'The octave practice exercises could not be prepared. Please try again.',
    { cause },
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sourceContext(measure: ExtractedMeasure, partId: string): Record<string, unknown> {
  const part = measure.parts.find((candidate) => candidate.id === partId) ?? measure.parts[0];
  const context: Record<string, unknown> = { ...(part?.startingContext ?? {}) };
  const attributes = part?.events.find((event) => event.kind === 'attributes');
  if (!attributes) return context;
  for (const [key, value] of Object.entries(attributes)) {
    if (!['keys', 'times'].includes(key) || !Array.isArray(value)) {
      context[key] = value;
      continue;
    }
    const updates = asRecordArray(value);
    if (updates.some((update) => update.staff === undefined)) {
      context[key] = value;
      continue;
    }
    const merged = asRecordArray(context[key]);
    for (const update of updates) {
      const matchIndex = merged.findIndex((candidate) => candidate.staff === update.staff);
      if (matchIndex >= 0) merged[matchIndex] = update;
      else merged.push(update);
    }
    context[key] = merged;
  }
  return context;
}

function sourceKeyXml(measure: ExtractedMeasure, partId: string): string {
  const keys = asRecordArray(sourceContext(measure, partId).keys);
  const key = keys.find((candidate) => candidate.staff === undefined || candidate.staff === 1) ?? keys[0];
  const fifths = Number.isInteger(key?.fifths) && Number(key?.fifths) >= -7 && Number(key?.fifths) <= 7
    ? Number(key?.fifths)
    : 0;
  const mode = typeof key?.mode === 'string' && /^[a-z-]{2,20}$/i.test(key.mode)
    ? `<mode>${escapeXml(key.mode.toLowerCase())}</mode>`
    : '';
  return `<key><fifths>${fifths}</fifths>${mode}</key>`;
}

function sourceTimeXml(measure: ExtractedMeasure, partId: string): string {
  const time = asRecordArray(sourceContext(measure, partId).times)[0];
  const beats = Array.isArray(time?.beats) ? time.beats[0] : undefined;
  const beatType = Array.isArray(time?.beatTypes) ? time.beatTypes[0] : undefined;
  if (
    typeof beats === 'string'
    && /^\d+(?:\+\d+)*$/.test(beats)
    && typeof beatType === 'string'
    && /^(1|2|4|8|16|32|64)$/.test(beatType)
  ) {
    return `<time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`;
  }
  return '<time><beats>4</beats><beat-type>4</beat-type></time>';
}

function handDescriptor(hands: OctaveHand[]): string {
  if (hands.length === 2) return 'two-hand';
  return hands[0] === 'right' ? 'right-hand' : 'left-hand';
}

function handTitle(hands: OctaveHand[]): string {
  if (hands.length === 2) return 'Both Hands';
  return hands[0] === 'right' ? 'Right Hand' : 'Left Hand';
}

function validateInstructionSentence(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const words = normalized.slice(0, -1).split(' ').filter(Boolean);
  if (
    /[\r\n;]/.test(value)
    || !normalized.endsWith('.')
    || /[.!?]/.test(normalized.slice(0, -1))
    || words.length < 4
    || words.length > 40
  ) {
    throw invalidOctaveExercise();
  }
  return normalized;
}

function methodById(methodId: OctaveMethodId): OctaveMethod {
  const method = OCTAVE_RULES.methods.find((candidate) => candidate.id === methodId);
  if (!method) throw invalidOctaveExercise();
  return method;
}

function exerciseCopy(
  methodId: OctaveMethodId,
  hands: OctaveHand[],
): Pick<GeneratedPracticeExercise, 'title' | 'explanationSentences'> {
  const method = methodById(methodId);
  const title = `${handTitle(hands)} ${method.title}`;
  if (title.split(/\s+/).length > 10 || /[.!?]/.test(title)) throw invalidOctaveExercise();
  const explanationSentences = method.sentenceTemplates.map((template) => (
    validateInstructionSentence(template.replace('{hand}', handDescriptor(hands)))
  )) as [string, string];
  return { title, explanationSentences };
}

function displayedStaves(context: OctavePracticeContext): Array<{
  sequence: OctaveHandSequence;
  number: number;
  clef: 'treble' | 'bass';
}> {
  return [...context.sequences]
    .sort((first, second) => first.sourceStaff - second.sourceStaff)
    .map((sequence, index) => ({
      sequence,
      number: index + 1,
      clef: sequence.hand === 'right' ? 'treble' : 'bass',
    }));
}

function sourceDurationForDrill(attack: OctaveAttack): DrillDuration {
  return {
    ticks: attack.writtenDuration.ticks,
    type: attack.writtenDuration.type,
    ...(attack.writtenDuration.dots > 0 ? { dots: attack.writtenDuration.dots } : {}),
    ...(attack.writtenDuration.timeModification
      ? { timeModification: attack.writtenDuration.timeModification }
      : {}),
  };
}

function fingerForPitch(hand: OctaveHand, position: 'lower' | 'upper'): 1 | 5 {
  if (hand === 'right') return position === 'lower' ? 1 : 5;
  return position === 'lower' ? 5 : 1;
}

function sourceOnsetKey(onsetQuarterNotes: number): number {
  return Math.round(onsetQuarterNotes / OCTAVE_RULES.detection.onsetToleranceQuarterNotes);
}

function fingerLineMeasures(context: OctavePracticeContext): DrillMeasure[] {
  const staves = displayedStaves(context);
  const origin = Math.min(...staves.flatMap(({ sequence }) => (
    sequence.attacks.map((attack) => attack.onsetQuarterNotes)
  )));

  return ([
    { label: 'Finger five only', line: 'finger-five' as const },
    { label: 'Thumb only', line: 'thumb' as const },
  ]).map(({ label, line }) => ({
    label,
    staves: staves.map(({ sequence, number, clef }) => ({
      hand: sequence.hand,
      number,
      clef,
      events: sequence.attacks.map((attack) => {
        const useUpper = line === 'finger-five'
          ? sequence.hand === 'right'
          : sequence.hand === 'left';
        const pitch = useUpper ? attack.upper : attack.lower;
        return {
          onsetTicks: Math.max(0, Math.round((attack.onsetQuarterNotes - origin) * TICKS_PER_QUARTER)),
          duration: sourceDurationForDrill(attack),
          pitches: [pitch],
          fingerings: [line === 'finger-five' ? 5 : 1],
        };
      }),
    })),
  }));
}

function transformedMeasure(
  context: OctavePracticeContext,
  label: string,
  buildDurations: (slotIndex: number) => DrillDuration[],
  articulation?: 'staccato',
  groupStops?: Set<number>,
): DrillMeasure {
  const staves = displayedStaves(context);
  const onsetKeys = [...new Set(staves.flatMap(({ sequence }) => (
    sequence.attacks.map((attack) => sourceOnsetKey(attack.onsetQuarterNotes))
  )))].sort((first, second) => first - second);
  const attacksByStaff = staves.map(({ sequence }) => new Map(
    sequence.attacks.map((attack) => [sourceOnsetKey(attack.onsetQuarterNotes), attack]),
  ));
  const eventsByStaff: DrillEvent[][] = staves.map(() => []);
  let cursor = 0;

  onsetKeys.forEach((onsetKey, slotIndex) => {
    const durations = buildDurations(slotIndex);
    durations.forEach((duration, durationIndex) => {
      staves.forEach(({ sequence }, staffIndex) => {
        const attack = attacksByStaff[staffIndex].get(onsetKey);
        const playAttack = durationIndex === 0 && attack;
        eventsByStaff[staffIndex].push(playAttack
          ? {
              onsetTicks: cursor,
              duration,
              pitches: [attack.lower, attack.upper],
              fingerings: [
                fingerForPitch(sequence.hand, 'lower'),
                fingerForPitch(sequence.hand, 'upper'),
              ],
              ...(articulation ? { articulation } : {}),
            }
          : {
              onsetTicks: cursor,
              duration,
              pitches: [],
              fingerings: [],
              rest: true,
            });
      });
      cursor += duration.ticks;
    });

    if (groupStops?.has(slotIndex)) {
      staves.forEach((_staff, staffIndex) => {
        eventsByStaff[staffIndex].push({
          onsetTicks: cursor,
          duration: QUARTER,
          pitches: [],
          fingerings: [],
          rest: true,
        });
      });
      cursor += QUARTER.ticks;
    }
  });

  return {
    label,
    staves: staves.map(({ sequence, number, clef }, staffIndex) => ({
      hand: sequence.hand,
      number,
      clef,
      events: eventsByStaff[staffIndex],
    })),
  };
}

function groupStopIndices(slotCount: number): Set<number> {
  const stops = new Set<number>();
  let index = 0;
  while (index < slotCount) {
    const remaining = slotCount - index;
    const size = remaining === 4 ? 2 : Math.min(3, remaining);
    index += size;
    stops.add(index - 1);
  }
  return stops;
}

function secondMethodMeasures(context: OctavePracticeContext): DrillMeasure[] {
  switch (context.selectedMethods[1]) {
    case 'dotted-rhythm-variations':
      return [
        transformedMeasure(context, 'Long-short rhythm', (index) => [index % 2 === 0 ? DOTTED_EIGHTH : SIXTEENTH]),
        transformedMeasure(context, 'Short-long rhythm', (index) => [index % 2 === 0 ? SIXTEENTH : DOTTED_EIGHTH]),
      ];
    case 'secure-landings':
      return [transformedMeasure(context, 'Release, move, and land', () => [QUARTER, QUARTER])];
    case 'release-and-reset':
      return [transformedMeasure(context, 'Short attack and full release', () => [EIGHTH, EIGHTH], 'staccato')];
    case 'short-groups': {
      const slotCount = new Set(context.sequences.flatMap((sequence) => (
        sequence.attacks.map((attack) => sourceOnsetKey(attack.onsetQuarterNotes))
      ))).size;
      return [
        transformedMeasure(context, 'Groups of two or three', () => [EIGHTH], undefined, groupStopIndices(slotCount)),
        transformedMeasure(context, 'Connected whole passage', () => [EIGHTH]),
      ];
    }
    default:
      throw invalidOctaveExercise();
  }
}

function writtenDurationXml(duration: DrillDuration): string {
  const dots = '<dot/>'.repeat(duration.dots ?? 0);
  const modification = duration.timeModification
    ? [
        '<time-modification>',
        `<actual-notes>${duration.timeModification.actualNotes}</actual-notes>`,
        `<normal-notes>${duration.timeModification.normalNotes}</normal-notes>`,
        duration.timeModification.normalType
          ? `<normal-type>${duration.timeModification.normalType}</normal-type>`
          : '',
        '<normal-dot/>'.repeat(duration.timeModification.normalDots ?? 0),
        '</time-modification>',
      ].join('')
    : '';
  return [
    `<type>${duration.type}</type>`,
    dots,
    modification,
  ].join('');
}

function notationsXml(event: DrillEvent, pitchIndex: number): string {
  const contents: string[] = [];
  if (event.articulation && pitchIndex === 0) {
    contents.push(`<articulations><${event.articulation}/></articulations>`);
  }
  const fingering = event.fingerings[pitchIndex];
  if (fingering) contents.push(`<technical><fingering>${fingering}</fingering></technical>`);
  return contents.length > 0 ? `<notations>${contents.join('')}</notations>` : '';
}

function drillEventXml(event: DrillEvent, staffNumber: number): string {
  if (event.rest) {
    return [
      '<note><rest/>',
      `<duration>${event.duration.ticks}</duration>`,
      `<voice>${staffNumber}</voice>`,
      writtenDurationXml(event.duration),
      `<staff>${staffNumber}</staff>`,
      '</note>',
    ].join('');
  }
  return event.pitches.map((pitch, pitchIndex) => [
    '<note>',
    pitchIndex > 0 ? '<chord/>' : '',
    '<pitch>',
    `<step>${pitch.step}</step>`,
    pitch.alter !== 0 ? `<alter>${pitch.alter}</alter>` : '',
    `<octave>${pitch.octave}</octave>`,
    '</pitch>',
    `<duration>${event.duration.ticks}</duration>`,
    `<voice>${staffNumber}</voice>`,
    writtenDurationXml(event.duration),
    `<staff>${staffNumber}</staff>`,
    notationsXml(event, pitchIndex),
    '</note>',
  ].join('')).join('');
}

function measureTotalTicks(measure: DrillMeasure): number {
  return Math.max(...measure.staves.flatMap((staff) => (
    staff.events.map((event) => event.onsetTicks + event.duration.ticks)
  )));
}

function staffTimelineXml(staff: DrillStaff, totalTicks: number): string {
  let cursor = 0;
  const xml: string[] = [];
  const events = [...staff.events].sort((first, second) => first.onsetTicks - second.onsetTicks);
  for (const event of events) {
    if (event.onsetTicks < cursor) throw invalidOctaveExercise();
    if (event.onsetTicks > cursor) {
      xml.push(
        `<forward><duration>${event.onsetTicks - cursor}</duration>`
        + `<voice>${staff.number}</voice><staff>${staff.number}</staff></forward>`,
      );
    }
    xml.push(drillEventXml(event, staff.number));
    cursor = event.onsetTicks + event.duration.ticks;
  }
  if (cursor < totalTicks) {
    xml.push(
      `<forward><duration>${totalTicks - cursor}</duration>`
      + `<voice>${staff.number}</voice><staff>${staff.number}</staff></forward>`,
    );
  }
  return xml.join('');
}

function clefsXml(staves: DrillStaff[]): string {
  return staves.map((staff) => {
    const sign = staff.clef === 'treble' ? 'G' : 'F';
    const line = staff.clef === 'treble' ? 2 : 4;
    const number = staves.length > 1 ? ` number="${staff.number}"` : '';
    return `<clef${number}><sign>${sign}</sign><line>${line}</line></clef>`;
  }).join('');
}

function serializeDrillMusicXml(
  title: string,
  measures: DrillMeasure[],
  sourceMeasure: ExtractedMeasure,
  sourcePartId: string,
): string {
  const measureXml = measures.map((measure, measureIndex) => {
    if (measure.staves.length < 1 || measure.staves.length > 2) throw invalidOctaveExercise();
    const totalTicks = measureTotalTicks(measure);
    if (totalTicks <= 0 || totalTicks > TICKS_PER_QUARTER * 256) throw invalidOctaveExercise();
    const contents: string[] = [];
    measure.staves.forEach((staff, staffIndex) => {
      if (staffIndex > 0) contents.push(`<backup><duration>${totalTicks}</duration></backup>`);
      contents.push(staffTimelineXml(staff, totalTicks));
    });
    return [
      `<measure number="${measureIndex + 1}" implicit="yes">`,
      measureIndex > 0 ? '<print new-system="yes"/>' : '',
      measureIndex === 0
        ? [
            '<attributes>',
            `<divisions>${TICKS_PER_QUARTER}</divisions>`,
            sourceKeyXml(sourceMeasure, sourcePartId),
            sourceTimeXml(sourceMeasure, sourcePartId),
            measure.staves.length > 1 ? `<staves>${measure.staves.length}</staves>` : '',
            clefsXml(measure.staves),
            '</attributes>',
          ].join('')
        : '',
      '<direction placement="above"><direction-type>',
      `<words font-style="italic">${escapeXml(measure.label)}</words>`,
      '</direction-type><staff>1</staff></direction>',
      contents.join(''),
      measureIndex === measures.length - 1
        ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>'
        : '',
      '</measure>',
    ].join('');
  }).join('');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<score-partwise version="4.0">',
    `<work><work-title>${escapeXml(title)}</work-title></work>`,
    '<part-list><score-part id="P1"><part-name>Octave Practice</part-name></score-part></part-list>',
    `<part id="P1">${measureXml}</part>`,
    '</score-partwise>',
  ].join('');
}

function expectedNotes(measure: DrillMeasure): ExpectedNote[] {
  return measure.staves.flatMap((staff) => (
    [...staff.events]
      .sort((first, second) => first.onsetTicks - second.onsetTicks)
      .flatMap<ExpectedNote>((event): ExpectedNote[] => {
        if (event.rest) {
          return [{
            staff: staff.number,
            onsetTicks: event.onsetTicks,
            durationTicks: event.duration.ticks,
            pitch: null,
            chord: false,
            fingering: null,
          }];
        }
        return event.pitches.map((pitch, pitchIndex) => ({
          staff: staff.number,
          onsetTicks: event.onsetTicks,
          durationTicks: event.duration.ticks,
          pitch: { step: pitch.step, alter: pitch.alter, octave: pitch.octave },
          chord: pitchIndex > 0,
          fingering: event.fingerings[pitchIndex] ? String(event.fingerings[pitchIndex]) : null,
        }));
      })
  ));
}

function eventFingering(event: Record<string, unknown>): string | null {
  const fingering = asRecordArray(event.technical).find((mark) => mark.name === 'fingering');
  return typeof fingering?.value === 'string' ? fingering.value : null;
}

function actualNotes(xml: string, measureIndex: number): ExpectedNote[] {
  const extracted = extractMeasureForAnalysis(xml, measureIndex);
  if (extracted.scoreFormat !== 'partwise' || extracted.parts.length !== 1) throw invalidOctaveExercise();
  return extracted.parts[0].events
    .filter((event) => event.kind === 'note')
    .map((event) => {
      const pitch = parsePitch(event.pitch);
      const durationQuarterNotes = finiteNumber(event.durationQuarterNotes);
      if (durationQuarterNotes === null) throw invalidOctaveExercise();
      return {
        staff: finiteNumber(event.staff) ?? 1,
        onsetTicks: Math.round((finiteNumber(event.onsetQuarterNotes) ?? 0) * TICKS_PER_QUARTER),
        durationTicks: Math.round(durationQuarterNotes * TICKS_PER_QUARTER),
        pitch: pitch
          ? { step: pitch.step, alter: pitch.alter, octave: pitch.octave }
          : null,
        chord: Boolean(event.chord),
        fingering: eventFingering(event),
      };
    });
}

export function validateOctaveExerciseMusicXml(
  xml: string,
  measures: DrillMeasure[],
  context: OctavePracticeContext,
  methodId: OctaveMethodId,
): void {
  try {
    if (
      Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES
      || /<!DOCTYPE\b|<!ENTITY\b/i.test(xml)
      || (xml.match(/<measure\b/g) ?? []).length !== measures.length
    ) {
      throw invalidOctaveExercise();
    }
    const parsed = assertMusicXml(xml);
    if (!parsed['score-partwise'] || parsed['score-timewise']) throw invalidOctaveExercise();
    const allowedPitches = new Set(context.sequences.flatMap((sequence) => (
      sequence.attacks.flatMap((attack) => [attack.lower, attack.upper])
        .map((pitch) => `${pitch.step}:${pitch.alter}:${pitch.octave}`)
    )));

    measures.forEach((measure, measureIndex) => {
      const expected = expectedNotes(measure);
      const actual = actualNotes(xml, measureIndex);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw invalidOctaveExercise();
      for (const note of actual) {
        if (note.pitch && !allowedPitches.has(`${note.pitch.step}:${note.pitch.alter}:${note.pitch.octave}`)) {
          throw invalidOctaveExercise();
        }
      }
    });

    if (methodId === 'separate-finger-lines') {
      if (measures.length !== 2 || measures.some((measure) => (
        measure.staves.some((staff) => staff.events.some((event) => event.rest || event.pitches.length !== 1))
      ))) {
        throw invalidOctaveExercise();
      }
    } else if (measures.some((measure) => measure.staves.some((staff) => (
      staff.events.some((event) => !event.rest && event.pitches.length !== 2)
    )))) {
      throw invalidOctaveExercise();
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'OCTAVE_EXERCISE_INVALID') throw error;
    throw invalidOctaveExercise(error);
  }
}

function generatedExercise(
  methodId: OctaveMethodId,
  measures: DrillMeasure[],
  context: OctavePracticeContext,
  sourceMeasure: ExtractedMeasure,
): GeneratedPracticeExercise {
  const copy = exerciseCopy(methodId, context.affectedHands);
  const musicXml = serializeDrillMusicXml(copy.title, measures, sourceMeasure, context.partId);
  validateOctaveExerciseMusicXml(musicXml, measures, context, methodId);
  return { ...copy, musicXml };
}

export function generateOctavePracticeExercises(
  sourceMeasure: ExtractedMeasure,
  context: OctavePracticeContext,
): [GeneratedPracticeExercise, GeneratedPracticeExercise] {
  if (
    context.rulesVersion !== OCTAVE_RULES.schemaVersion
    || context.selectedMethods[0] !== 'separate-finger-lines'
    || context.selectedMethods[1] !== OCTAVE_RULES.selection.secondExerciseByPattern[context.pattern]
    || context.sequences.length !== context.affectedHands.length
  ) {
    throw invalidOctaveExercise();
  }
  return [
    generatedExercise('separate-finger-lines', fingerLineMeasures(context), context, sourceMeasure),
    generatedExercise(context.selectedMethods[1], secondMethodMeasures(context), context, sourceMeasure),
  ];
}

export function materializeOctavePracticeAnalysis(
  analysis: string,
  sourceMeasure: ExtractedMeasure,
  context: OctavePracticeContext,
): GeneratedMeasureAnalysis {
  const normalizedAnalysis = analysis.trim();
  if (!normalizedAnalysis) throw invalidOctaveExercise();
  return {
    analysis: normalizedAnalysis,
    exercises: generateOctavePracticeExercises(sourceMeasure, context),
  };
}
