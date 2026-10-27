import { z } from 'zod';
import { AppError } from './errors.js';
import { extractMeasureForAnalysis } from './measure.js';
import type { ExtractedMeasure, ExtractedMeasurePart } from './measure.js';
import { AIAnalysisTextSchema, validateAnalysisText } from './exercise-musicxml.js';
import type { GeneratedMeasureAnalysis, GeneratedPracticeExercise } from './exercise-musicxml.js';
import {
  eligibleOctaveMethodIds,
  getOctaveMethod,
  getOctavePracticeRules as getCanonicalOctaveRules,
  getOctaveRulesFileReadCount as getCanonicalOctaveRulesFileReadCount,
  octaveSelectionPromptSummary,
  selectOctaveMethodPair,
} from './octave-rules.js';
import type {
  OctaveMethodId,
  OctavePattern,
  OctavePracticeMethod,
} from './octave-rules.js';

const HandSchema = z.enum(['right', 'left']);

const OCTAVE_RULES = getCanonicalOctaveRules();

export const AIOctaveAnalysisSchema = z.object({
  analysis: AIAnalysisTextSchema,
}).strict();

export type OctaveHand = z.infer<typeof HandSchema>;
export type { OctaveMethodId, OctavePattern } from './octave-rules.js';

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
  sourceOrdinal: number;
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

export function getOctavePracticeRules(): Readonly<typeof OCTAVE_RULES> {
  return OCTAVE_RULES;
}

export function getOctaveRulesFileReadCount(): number {
  return getCanonicalOctaveRulesFileReadCount();
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
      && Math.abs(interval) <= OCTAVE_RULES.detection.maximumScaleLikeStepSemitones
    ));
  const mixedKinds = [repeatedTransitions > 0, jumpTransitions > 0, isRun].filter(Boolean).length;

  if (attacks.length >= OCTAVE_RULES.detection.progressiveMinimumAttacks && mixedKinds > 1) {
    return { pattern: 'long-mixed', repeatedTransitions, jumpTransitions };
  }
  if (repeatedTransitions > 0 && repeatedTransitions >= Math.ceil(intervals.length / 2)) {
    return { pattern: 'repeated', repeatedTransitions, jumpTransitions };
  }
  if (jumpTransitions > 0) return { pattern: 'jumps', repeatedTransitions, jumpTransitions };
  if (isRun) return { pattern: 'runs', repeatedTransitions, jumpTransitions };
  if (attacks.length >= OCTAVE_RULES.detection.progressiveMinimumAttacks) {
    return { pattern: 'long-mixed', repeatedTransitions, jumpTransitions };
  }
  if (repeatedTransitions > 0) return { pattern: 'repeated', repeatedTransitions, jumpTransitions };
  return { pattern: null, repeatedTransitions, jumpTransitions };
}

function attacksForPart(part: ExtractedMeasurePart): OctaveAttack[] {
  const groups = new Map<string, CandidateNote[]>();
  const timelineOnsets = new Map<string, Set<number>>();
  for (const event of part.events) {
    if (event.kind !== 'note' || event.grace) continue;
    const onset = finiteNumber(event.onsetQuarterNotes);
    const staff = finiteNumber(event.staff);
    const voice = typeof event.voice === 'string' ? event.voice : String(event.voice ?? '1');
    if (onset === null || (staff !== 1 && staff !== 2)) continue;
    const onsetKey = Math.round(onset / OCTAVE_RULES.detection.onsetToleranceQuarterNotes);
    const voiceKey = `${staff}\u0000${voice}`;
    const onsets = timelineOnsets.get(voiceKey) ?? new Set<number>();
    onsets.add(onsetKey);
    timelineOnsets.set(voiceKey, onsets);
    if (event.rest || tieStopsAttack(event)) continue;
    const pitch = parsePitch(event.pitch);
    const duration = finiteNumber(event.durationQuarterNotes);
    if (!pitch || duration === null || duration <= 0) continue;
    const key = `${staff}\u0000${voice}\u0000${onsetKey}`;
    const notes = groups.get(key) ?? [];
    notes.push({ pitch, durationQuarterNotes: duration, event });
    groups.set(key, notes);
  }

  const ordinalByVoice = new Map<string, Map<number, number>>();
  for (const [voiceKey, onsets] of timelineOnsets) {
    ordinalByVoice.set(voiceKey, new Map(
      [...onsets].sort((first, second) => first - second)
        .map((onsetKey, index) => [onsetKey, index]),
    ));
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
    const [staffText, voice, onsetKeyText] = key.split('\u0000');
    const sourceStaff = Number(staffText) as 1 | 2;
    const sourceOrdinal = ordinalByVoice.get(`${staffText}\u0000${voice}`)?.get(Number(onsetKeyText));
    if (sourceOrdinal === undefined) continue;
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
      sourceOrdinal,
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
  const addCandidate = (sequenceAttacks: OctaveAttack[]) => {
    const classification = sequencePattern(sequenceAttacks);
    if (!classification.pattern) return;
    candidates.push({
      hand: sequenceAttacks[0].hand,
      sourceStaff: sequenceAttacks[0].sourceStaff,
      voice: sequenceAttacks[0].voice,
      attacks: sequenceAttacks,
      pattern: classification.pattern,
      repeatedTransitions: classification.repeatedTransitions,
      jumpTransitions: classification.jumpTransitions,
    });
  };
  for (const sequenceAttacks of byVoice.values()) {
    let consecutive: OctaveAttack[] = [];
    for (const attack of sequenceAttacks) {
      if (
        consecutive.length > 0
        && attack.sourceOrdinal !== consecutive[consecutive.length - 1].sourceOrdinal + 1
      ) {
        addCandidate(consecutive);
        consecutive = [];
      }
      consecutive.push(attack);
    }
    if (consecutive.length > 0) addCandidate(consecutive);
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
  const attackCount = Math.min(...sequences.map((sequence) => sequence.attacks.length));
  if (patterns.size > 1 && attackCount >= OCTAVE_RULES.detection.progressiveMinimumAttacks) {
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
  const attackCount = Math.min(...selected.sequences.map((sequence) => sequence.attacks.length));
  const selectedMethods = selectOctaveMethodPair(pattern, attackCount);
  if (!selectedMethods) return null;
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
    selectedMethods: [...selectedMethods],
  };
}

export function octavePracticePromptSummary(context: OctavePracticeContext): Record<string, unknown> {
  const attackCount = Math.min(...context.sequences.map((sequence) => sequence.attacks.length));
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
    trustedTeachingReference: octaveSelectionPromptSummary(
      context.pattern,
      attackCount,
      context.selectedMethods,
    ),
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
  fingerings: Array<1 | 4 | 5>;
  rest?: boolean;
  articulation?: 'accent';
}

interface DrillStaff {
  hand: OctaveHand;
  sourceStaff: 1 | 2;
  number: number;
  clef: 'treble' | 'bass';
  events: DrillEvent[];
}

interface DrillMeasure {
  label: string;
  staves: DrillStaff[];
  directions?: string[];
  endDirections?: string[];
}

type DrillBeamValue = 'begin' | 'continue' | 'end' | 'forward hook' | 'backward hook';

interface DrillBeam {
  number: number;
  value: DrillBeamValue;
}

interface ExpectedNote {
  staff: number;
  onsetTicks: number;
  durationTicks: number;
  pitch: { step: string; alter: number; octave: number } | null;
  chord: boolean;
  fingering: string | null;
  articulation: string | null;
  beams: DrillBeam[];
}

const DOTTED_EIGHTH: DrillDuration = { ticks: 36, type: 'eighth', dots: 1 };
const SIXTEENTH: DrillDuration = { ticks: 12, type: '16th' };
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

function sourceKey(
  measure: ExtractedMeasure,
  partId: string,
  staff: number,
): Record<string, unknown> | undefined {
  const keys = asRecordArray(sourceContext(measure, partId).keys);
  return keys.find((candidate) => candidate.staff === staff)
    ?? keys.find((candidate) => candidate.staff === undefined)
    ?? keys[0];
}

function sourceKeyFifths(measure: ExtractedMeasure, partId: string, staff = 1): number {
  const key = sourceKey(measure, partId, staff);
  return Number.isInteger(key?.fifths) && Number(key?.fifths) >= -7 && Number(key?.fifths) <= 7
    ? Number(key?.fifths)
    : 0;
}

function sourceKeysXml(
  measure: ExtractedMeasure,
  partId: string,
  staves: DrillStaff[],
): string {
  return staves.map((staff) => {
    const key = sourceKey(measure, partId, staff.sourceStaff);
    const fifths = sourceKeyFifths(measure, partId, staff.sourceStaff);
    const mode = typeof key?.mode === 'string' && /^[a-z-]{2,20}$/i.test(key.mode)
      ? `<mode>${escapeXml(key.mode.toLowerCase())}</mode>`
      : '';
    const number = staves.length > 1 ? ` number="${staff.number}"` : '';
    return `<key${number}><fifths>${fifths}</fifths>${mode}</key>`;
  }).join('');
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
    || words.length > 20
  ) {
    throw invalidOctaveExercise();
  }
  return normalized;
}

function methodById(methodId: OctaveMethodId): Readonly<OctavePracticeMethod> {
  try {
    return getOctaveMethod(methodId);
  } catch (error) {
    throw invalidOctaveExercise(error);
  }
}

function exerciseCopy(
  methodId: OctaveMethodId,
  hands: OctaveHand[],
): Pick<GeneratedPracticeExercise, 'title' | 'explanationSentences'> {
  const method = methodById(methodId);
  const title = `${handTitle(hands)} ${method.title}`;
  if (title.split(/\s+/).length > 10 || /[.!?]/.test(title)) throw invalidOctaveExercise();
  const explanationSentences = method.instructions.map((template) => (
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

function isBlackKey(pitch: OctavePitch): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch.midi % 12) + 12) % 12);
}

function outerFinger(pitch: OctavePitch): 4 | 5 {
  return isBlackKey(pitch)
    ? OCTAVE_RULES.handRules.outerFingerByKeyColor.black
    : OCTAVE_RULES.handRules.outerFingerByKeyColor.white;
}

function fingerForPitch(
  hand: OctaveHand,
  position: 'lower' | 'upper',
  pitch: OctavePitch,
): 1 | 4 | 5 {
  const isOuter = hand === 'right' ? position === 'upper' : position === 'lower';
  return isOuter ? outerFinger(pitch) : OCTAVE_RULES.handRules.thumbFinger;
}

function octaveFingerings(hand: OctaveHand, lower: OctavePitch, upper: OctavePitch): Array<1 | 4 | 5> {
  return [
    fingerForPitch(hand, 'lower', lower),
    fingerForPitch(hand, 'upper', upper),
  ];
}

function sourceOnsetKey(onsetQuarterNotes: number): number {
  return Math.round(onsetQuarterNotes / OCTAVE_RULES.detection.onsetToleranceQuarterNotes);
}

function fingerLineMeasures(context: OctavePracticeContext): DrillMeasure[] {
  const staves = displayedStaves(context);

  return ([
    { label: 'Outer fingers only', line: 'outer' as const },
    { label: 'Finger one only', line: 'thumb' as const },
  ]).map(({ label, line }) => ({
    label,
    staves: staves.map(({ sequence, number, clef }) => ({
      hand: sequence.hand,
      sourceStaff: sequence.sourceStaff,
      number,
      clef,
      events: sequence.attacks.map((attack, index) => {
        const useUpper = line === 'outer'
          ? sequence.hand === 'right'
          : sequence.hand === 'left';
        const pitch = useUpper ? attack.upper : attack.lower;
        return {
          onsetTicks: index * EIGHTH.ticks,
          duration: EIGHTH,
          pitches: [pitch],
          fingerings: [line === 'outer' ? outerFinger(pitch) : OCTAVE_RULES.handRules.thumbFinger],
        };
      }),
    })),
  }));
}

function transformedMeasure(
  context: OctavePracticeContext,
  label: string,
  buildDurations: (slotIndex: number) => DrillDuration[],
  articulation?: 'accent',
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
              fingerings: octaveFingerings(sequence.hand, attack.lower, attack.upper),
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
          duration: EIGHTH,
          pitches: [],
          fingerings: [],
          rest: true,
        });
      });
      cursor += EIGHTH.ticks;
    }
  });

  return {
    label,
    staves: staves.map(({ sequence, number, clef }, staffIndex) => ({
      hand: sequence.hand,
      sourceStaff: sequence.sourceStaff,
      number,
      clef,
      events: eventsByStaff[staffIndex],
    })),
  };
}

const DIATONIC_STEPS: OctavePitch['step'][] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SHARP_ORDER: OctavePitch['step'][] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER: OctavePitch['step'][] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

function keySignatureAlter(step: OctavePitch['step'], fifths: number): number {
  if (fifths > 0 && SHARP_ORDER.slice(0, fifths).includes(step)) return 1;
  if (fifths < 0 && FLAT_ORDER.slice(0, Math.abs(fifths)).includes(step)) return -1;
  return 0;
}

function fiveNoteScale(
  sequence: OctaveHandSequence,
  sourceMeasure: ExtractedMeasure,
  partId: string,
): OctavePitch[] {
  const start = sequence.attacks.reduce((lowest, attack) => (
    attack.lower.midi < lowest.midi ? attack.lower : lowest
  ), sequence.attacks[0].lower);
  const fifths = sourceKeyFifths(sourceMeasure, partId, sequence.sourceStaff);
  const pitches: OctavePitch[] = [{ ...start }];
  let stepIndex = DIATONIC_STEPS.indexOf(start.step);
  let octave = start.octave;
  for (let index = 1; index < 5; index += 1) {
    if (DIATONIC_STEPS[stepIndex] === 'B') octave += 1;
    stepIndex = (stepIndex + 1) % DIATONIC_STEPS.length;
    const step = DIATONIC_STEPS[stepIndex];
    const alter = keySignatureAlter(step, fifths);
    pitches.push({ step, alter, octave, midi: midiNumber({ step, alter, octave }) });
  }
  if (pitches.some((pitch) => pitch.midi < 21 || pitch.midi + 12 > 108)) {
    throw invalidOctaveExercise();
  }
  return pitches;
}

function octaveEvent(
  lower: OctavePitch,
  hand: OctaveHand,
  onsetTicks: number,
  articulation?: 'accent',
): DrillEvent {
  const upper: OctavePitch = { ...lower, octave: lower.octave + 1, midi: lower.midi + 12 };
  return {
    onsetTicks,
    duration: EIGHTH,
    pitches: [lower, upper],
    fingerings: octaveFingerings(hand, lower, upper),
    ...(articulation ? { articulation } : {}),
  };
}

function oneHandMeasure(
  sequence: OctaveHandSequence,
  label: string,
  events: DrillEvent[],
  directions: string[] = [],
): DrillMeasure {
  return {
    label,
    directions,
    staves: [{
      hand: sequence.hand,
      sourceStaff: sequence.sourceStaff,
      number: 1,
      clef: sequence.hand === 'right' ? 'treble' : 'bass',
      events,
    }],
  };
}

function dottedRhythmMeasures(context: OctavePracticeContext): DrillMeasure[] {
  return [
    transformedMeasure(
      context,
      'Dotted eighth then sixteenth',
      (index) => [index % 2 === 0 ? DOTTED_EIGHTH : SIXTEENTH],
    ),
    transformedMeasure(
      context,
      'Sixteenth then dotted eighth',
      (index) => [index % 2 === 0 ? SIXTEENTH : DOTTED_EIGHTH],
    ),
  ];
}

function expandingPatternMeasures(
  context: OctavePracticeContext,
  sourceMeasure: ExtractedMeasure,
): DrillMeasure[] {
  const method = getOctaveMethod('octave-expanding-five-note-pattern');
  if (method.id !== 'octave-expanding-five-note-pattern') throw invalidOctaveExercise();
  const measures: DrillMeasure[] = [];
  for (const sequence of [...context.sequences].sort((first, second) => first.sourceStaff - second.sourceStaff)) {
    const scale = fiveNoteScale(sequence, sourceMeasure, context.partId);
    method.notation.scaleDegreePatterns.forEach((degrees, patternIndex) => {
      const events = degrees.map((degree, eventIndex) => (
        octaveEvent(scale[degree - 1], sequence.hand, eventIndex * EIGHTH.ticks)
      ));
      measures.push(oneHandMeasure(
        sequence,
        `${handTitle([sequence.hand])} ${patternIndex + 2}-note expansion`,
        events,
        measures.length === 0 ? [OCTAVE_RULES.wording.enduranceDirection] : [],
      ));
    });
  }
  return measures;
}

function alternatingAccentMeasures(
  context: OctavePracticeContext,
  sourceMeasure: ExtractedMeasure,
): DrillMeasure[] {
  const method = getOctaveMethod('octave-five-note-alternating-accents');
  if (method.id !== 'octave-five-note-alternating-accents') throw invalidOctaveExercise();
  const accentIndexes = new Set<number>(method.notation.accentEventIndexesPerMeasure);
  const measures: DrillMeasure[] = [];
  for (const sequence of [...context.sequences].sort((first, second) => first.sourceStaff - second.sourceStaff)) {
    const scale = fiveNoteScale(sequence, sourceMeasure, context.partId);
    for (let repetition = 0; repetition < method.notation.measureCount; repetition += 1) {
      const events = method.notation.scaleDegreePatternPerMeasure.map((degree, eventIndex) => (
        octaveEvent(
          scale[degree - 1],
          sequence.hand,
          eventIndex * EIGHTH.ticks,
          accentIndexes.has(eventIndex) ? 'accent' : undefined,
        )
      ));
      measures.push(oneHandMeasure(
        sequence,
        `${handTitle([sequence.hand])} accent pattern ${repetition + 1}`,
        events,
        measures.length === 0 ? [OCTAVE_RULES.wording.enduranceDirection] : [],
      ));
    }
  }
  return measures;
}

function repeatedPairAccentMeasures(context: OctavePracticeContext): DrillMeasure[] {
  const method = getOctaveMethod('octave-repeated-pairs-alternating-accents');
  if (method.id !== 'octave-repeated-pairs-alternating-accents') throw invalidOctaveExercise();
  const measures: DrillMeasure[] = [];
  for (const sequence of [...context.sequences].sort((first, second) => first.sourceStaff - second.sourceStaff)) {
    if (sequence.attacks.length < 1) throw invalidOctaveExercise();
    const positions = Array.from(
      { length: method.notation.positionCount },
      (_unused, index) => sequence.attacks[index % sequence.attacks.length],
    );
    const repeatedPositions = positions.flatMap((attack) => (
      Array.from({ length: method.notation.repeatEachPosition }, () => attack)
    ));
    const accentIndexes = [
      method.notation.firstMeasureAccentEventIndexes,
      method.notation.secondMeasureAccentEventIndexes,
    ];
    accentIndexes.forEach((measureAccentIndexes, measureIndex) => {
      const accents = new Set<number>(measureAccentIndexes);
      const events = repeatedPositions.map((attack, eventIndex) => (
        octaveEvent(
          attack.lower,
          sequence.hand,
          eventIndex * EIGHTH.ticks,
          accents.has(eventIndex) ? 'accent' : undefined,
        )
      ));
      measures.push(oneHandMeasure(
        sequence,
        `${handTitle([sequence.hand])} repeated-pair accents ${measureIndex + 1}`,
        events,
      ));
    });
  }
  return measures;
}

function progressiveGroupMeasures(context: OctavePracticeContext): DrillMeasure[] {
  const staves = displayedStaves(context);
  const totalAttacks = Math.min(...staves.map(({ sequence }) => sequence.attacks.length));
  const groupCount = Math.min(3, totalAttacks - 1);
  if (groupCount < 1 || totalAttacks < OCTAVE_RULES.detection.progressiveMinimumAttacks) {
    throw invalidOctaveExercise();
  }
  const eventsByStaff = staves.map(() => [] as DrillEvent[]);
  let cursor = 0;
  for (let groupSize = 1; groupSize <= groupCount; groupSize += 1) {
    for (let attackIndex = 0; attackIndex < groupSize; attackIndex += 1) {
      staves.forEach(({ sequence }, staffIndex) => {
        const attack = sequence.attacks[attackIndex];
        eventsByStaff[staffIndex].push({
          onsetTicks: cursor,
          duration: EIGHTH,
          pitches: [attack.lower, attack.upper],
          fingerings: octaveFingerings(sequence.hand, attack.lower, attack.upper),
        });
      });
      cursor += EIGHTH.ticks;
    }
    staves.forEach((_staff, staffIndex) => {
      eventsByStaff[staffIndex].push({
        onsetTicks: cursor,
        duration: EIGHTH,
        pitches: [],
        fingerings: [],
        rest: true,
      });
    });
    cursor += EIGHTH.ticks;
  }
  return [{
    label: 'Add one octave per group',
    endDirections: [OCTAVE_RULES.wording.continuationDirection],
    staves: staves.map(({ sequence, number, clef }, staffIndex) => ({
      hand: sequence.hand,
      sourceStaff: sequence.sourceStaff,
      number,
      clef,
      events: eventsByStaff[staffIndex],
    })),
  }];
}

function measuresForMethod(
  methodId: OctaveMethodId,
  context: OctavePracticeContext,
  sourceMeasure: ExtractedMeasure,
): DrillMeasure[] {
  switch (methodId) {
    case 'octave-separate-finger-lines':
      return fingerLineMeasures(context);
    case 'octave-dotted-rhythm-variations':
      return dottedRhythmMeasures(context);
    case 'octave-expanding-five-note-pattern':
      return expandingPatternMeasures(context, sourceMeasure);
    case 'octave-five-note-alternating-accents':
      return alternatingAccentMeasures(context, sourceMeasure);
    case 'octave-progressive-groups-with-rests':
      return progressiveGroupMeasures(context);
    case 'octave-repeated-pairs-alternating-accents':
      return repeatedPairAccentMeasures(context);
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

function beamLevel(duration: DrillDuration): number {
  switch (duration.type) {
    case 'eighth': return 1;
    case '16th': return 2;
    case '32nd': return 3;
    case '64th': return 4;
    case '128th': return 5;
    case '256th': return 6;
    case '512th': return 7;
    case '1024th': return 8;
    default: return 0;
  }
}

function isolatedBeamHook(run: DrillEvent[], eventIndex: number): DrillBeamValue {
  const event = run[eventIndex];
  const previous = run[eventIndex - 1];
  const next = run[eventIndex + 1];
  const beat = Math.floor(event.onsetTicks / TICKS_PER_QUARTER);
  const previousSharesBeat = previous
    ? Math.floor(previous.onsetTicks / TICKS_PER_QUARTER) === beat
    : false;
  const nextSharesBeat = next
    ? Math.floor(next.onsetTicks / TICKS_PER_QUARTER) === beat
    : false;

  if (nextSharesBeat && !previousSharesBeat) return 'forward hook';
  if (previousSharesBeat) return 'backward hook';
  return next ? 'forward hook' : 'backward hook';
}

function addBeamRun(
  run: DrillEvent[],
  assignments: Map<DrillEvent, DrillBeam[]>,
): void {
  if (run.length < 2) return;

  run.forEach((event, index) => {
    const value: DrillBeamValue = index === 0
      ? 'begin'
      : index === run.length - 1
        ? 'end'
        : 'continue';
    assignments.get(event)?.push({ number: 1, value });
  });

  const maximumLevel = Math.max(...run.map((event) => beamLevel(event.duration)));
  for (let level = 2; level <= maximumLevel; level += 1) {
    run.forEach((event, index) => {
      if (beamLevel(event.duration) < level) return;
      const previousContinues = index > 0 && beamLevel(run[index - 1].duration) >= level;
      const nextContinues = index + 1 < run.length && beamLevel(run[index + 1].duration) >= level;
      let value: DrillBeamValue;
      if (previousContinues && nextContinues) value = 'continue';
      else if (nextContinues) value = 'begin';
      else if (previousContinues) value = 'end';
      else value = isolatedBeamHook(run, index);
      assignments.get(event)?.push({ number: level, value });
    });
  }
}

function drillBeamAssignments(events: DrillEvent[]): Map<DrillEvent, DrillBeam[]> {
  const ordered = [...events].sort((first, second) => first.onsetTicks - second.onsetTicks);
  const assignments = new Map(ordered.map((event) => [event, [] as DrillBeam[]]));
  let run: DrillEvent[] = [];

  const finishRun = () => {
    addBeamRun(run, assignments);
    run = [];
  };

  for (const event of ordered) {
    const previous = run[run.length - 1];
    const followsPrevious = !previous
      || event.onsetTicks === previous.onsetTicks + previous.duration.ticks;
    if (
      event.rest
      || event.pitches.length === 0
      || beamLevel(event.duration) === 0
    ) {
      finishRun();
      continue;
    }
    if (!followsPrevious) finishRun();
    run.push(event);
  }
  finishRun();
  return assignments;
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

function drillEventXml(event: DrillEvent, staffNumber: number, beams: DrillBeam[]): string {
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
    pitchIndex === 0
      ? beams.map((beam) => `<beam number="${beam.number}">${beam.value}</beam>`).join('')
      : '',
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
  const beamAssignments = drillBeamAssignments(events);
  for (const event of events) {
    if (event.onsetTicks < cursor) throw invalidOctaveExercise();
    if (event.onsetTicks > cursor) {
      xml.push(
        `<forward><duration>${event.onsetTicks - cursor}</duration>`
        + `<voice>${staff.number}</voice><staff>${staff.number}</staff></forward>`,
      );
    }
    xml.push(drillEventXml(event, staff.number, beamAssignments.get(event) ?? []));
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
  const directionXml = (value: string) => [
    '<direction placement="above"><direction-type>',
    `<words font-style="italic">${escapeXml(value)}</words>`,
    '</direction-type><staff>1</staff></direction>',
  ].join('');
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
      '<attributes>',
      `<divisions>${TICKS_PER_QUARTER}</divisions>`,
      sourceKeysXml(sourceMeasure, sourcePartId, measure.staves),
      sourceTimeXml(sourceMeasure, sourcePartId),
      measure.staves.length > 1 ? `<staves>${measure.staves.length}</staves>` : '',
      clefsXml(measure.staves),
      '</attributes>',
      measureIndex === 0
        ? '<barline location="left"><bar-style>heavy-light</bar-style></barline>'
        : '',
      [measure.label, ...(measure.directions ?? [])].map(directionXml).join(''),
      contents.join(''),
      (measure.endDirections ?? []).map(directionXml).join(''),
      measureIndex === measures.length - 1
        ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>'
        : '<barline location="right"><bar-style>regular</bar-style></barline>',
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
  return measure.staves.flatMap((staff) => {
    const events = [...staff.events]
      .sort((first, second) => first.onsetTicks - second.onsetTicks);
    const beamAssignments = drillBeamAssignments(events);
    return events
      .flatMap<ExpectedNote>((event): ExpectedNote[] => {
        if (event.rest) {
          return [{
            staff: staff.number,
            onsetTicks: event.onsetTicks,
            durationTicks: event.duration.ticks,
            pitch: null,
            chord: false,
            fingering: null,
            articulation: null,
            beams: [],
          }];
        }
        return event.pitches.map((pitch, pitchIndex) => ({
          staff: staff.number,
          onsetTicks: event.onsetTicks,
          durationTicks: event.duration.ticks,
          pitch: { step: pitch.step, alter: pitch.alter, octave: pitch.octave },
          chord: pitchIndex > 0,
          fingering: event.fingerings[pitchIndex] ? String(event.fingerings[pitchIndex]) : null,
          articulation: pitchIndex === 0 ? event.articulation ?? null : null,
          beams: pitchIndex === 0 ? beamAssignments.get(event) ?? [] : [],
        }));
      });
  });
}

function eventFingering(event: Record<string, unknown>): string | null {
  const fingering = asRecordArray(event.technical).find((mark) => mark.name === 'fingering');
  return typeof fingering?.value === 'string' ? fingering.value : null;
}

function eventArticulation(event: Record<string, unknown>): string | null {
  const articulation = asRecordArray(event.articulations)[0];
  return typeof articulation?.name === 'string' ? articulation.name : null;
}

function eventBeams(event: Record<string, unknown>): DrillBeam[] {
  return asRecordArray(event.beams).map((beam) => {
    const number = finiteNumber(beam.number);
    const value = beam.value;
    if (
      number === null
      || !Number.isInteger(number)
      || typeof value !== 'string'
      || !['begin', 'continue', 'end', 'forward hook', 'backward hook'].includes(value)
    ) {
      throw invalidOctaveExercise();
    }
    return { number, value: value as DrillBeamValue };
  });
}

function generatedMeasurePart(xml: string, measureIndex: number): ExtractedMeasurePart {
  const extracted = extractMeasureForAnalysis(xml, measureIndex);
  if (extracted.scoreFormat !== 'partwise' || extracted.parts.length !== 1) throw invalidOctaveExercise();
  return extracted.parts[0];
}

function actualNotes(part: ExtractedMeasurePart): ExpectedNote[] {
  return part.events
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
        articulation: eventArticulation(event),
        beams: eventBeams(event),
      };
    });
}

function actualBarlines(
  part: ExtractedMeasurePart,
): Array<{ location: unknown; style: unknown }> {
  return part.events
    .filter((event) => event.kind === 'barline')
    .map((event) => ({ location: event.location, style: event.style }));
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
    const generatedParts = measures.map((_, measureIndex) => generatedMeasurePart(xml, measureIndex));
    measures.forEach((measure, measureIndex) => {
      const expected = expectedNotes(measure);
      const part = generatedParts[measureIndex];
      const actual = actualNotes(part);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw invalidOctaveExercise();
      const expectedBarlineStyle = measureIndex === measures.length - 1 ? 'light-heavy' : 'regular';
      const barlines = actualBarlines(part);
      const expectedBarlines = [
        ...(measureIndex === 0 ? [{ location: 'left', style: 'heavy-light' }] : []),
        { location: 'right', style: expectedBarlineStyle },
      ];
      if (JSON.stringify(barlines) !== JSON.stringify(expectedBarlines)) {
        throw invalidOctaveExercise();
      }
    });

    const events = measures.flatMap((measure) => measure.staves.flatMap((staff) => staff.events));
    if (
      methodId !== 'octave-dotted-rhythm-variations'
      && events.some((event) => event.duration.ticks !== EIGHTH.ticks || event.duration.type !== 'eighth')
    ) {
      throw invalidOctaveExercise();
    }
    switch (methodId) {
      case 'octave-separate-finger-lines':
        if (measures.length !== 2 || events.some((event) => event.rest || event.pitches.length !== 1)) {
          throw invalidOctaveExercise();
        }
        break;
      case 'octave-dotted-rhythm-variations':
        if (measures.length !== 2 || events.some((event) => !event.rest && event.pitches.length !== 2)) {
          throw invalidOctaveExercise();
        }
        break;
      case 'octave-expanding-five-note-pattern':
        if (
          measures.length !== context.sequences.length * 4
          || events.some((event) => event.rest || event.pitches.length !== 2)
          || !xml.includes(escapeXml(OCTAVE_RULES.wording.enduranceDirection))
        ) {
          throw invalidOctaveExercise();
        }
        break;
      case 'octave-five-note-alternating-accents':
        if (
          measures.length !== context.sequences.length * 2
          || measures.some((measure) => measure.staves.some((staff) => (
            staff.events.length !== 8
            || staff.events.some((event) => event.rest || event.pitches.length !== 2)
            || staff.events.some((event, index) => (
              event.articulation !== ([0, 4].includes(index) ? 'accent' : undefined)
            ))
          )))
          || !xml.includes(escapeXml(OCTAVE_RULES.wording.enduranceDirection))
        ) {
          throw invalidOctaveExercise();
        }
        break;
      case 'octave-progressive-groups-with-rests': {
        const attackCount = Math.min(...context.sequences.map((sequence) => sequence.attacks.length));
        const groupCount = Math.min(3, attackCount - 1);
        if (
          measures.length !== 1
          || measures[0].staves.some((staff) => (
            staff.events.filter((event) => event.rest).length !== groupCount
            || staff.events.filter((event) => !event.rest).length !== (groupCount * (groupCount + 1)) / 2
            || staff.events.some((event) => !event.rest && event.pitches.length !== 2)
          ))
          || !xml.includes(`>${escapeXml(OCTAVE_RULES.wording.continuationDirection)}<`)
        ) {
          throw invalidOctaveExercise();
        }
        break;
      }
      case 'octave-repeated-pairs-alternating-accents': {
        const method = getOctaveMethod(methodId);
        if (method.id !== 'octave-repeated-pairs-alternating-accents') throw invalidOctaveExercise();
        const sequences = [...context.sequences]
          .sort((first, second) => first.sourceStaff - second.sourceStaff);
        if (measures.length !== sequences.length * method.notation.measureCount) {
          throw invalidOctaveExercise();
        }
        sequences.forEach((sequence, sequenceIndex) => {
          const positions = Array.from(
            { length: method.notation.positionCount },
            (_unused, index) => sequence.attacks[index % sequence.attacks.length],
          );
          const expectedAttacks = positions.flatMap((attack) => (
            Array.from({ length: method.notation.repeatEachPosition }, () => attack)
          ));
          [
            method.notation.firstMeasureAccentEventIndexes,
            method.notation.secondMeasureAccentEventIndexes,
          ].forEach((accentIndexes, measureOffset) => {
            const measure = measures[sequenceIndex * method.notation.measureCount + measureOffset];
            const staff = measure?.staves[0];
            const accents = new Set<number>(accentIndexes);
            if (
              !staff
              || measure.staves.length !== 1
              || staff.hand !== sequence.hand
              || staff.sourceStaff !== sequence.sourceStaff
              || staff.events.length !== expectedAttacks.length
              || staff.events.some((event, eventIndex) => {
                const expectedAttack = expectedAttacks[eventIndex];
                return Boolean(event.rest)
                  || event.pitches.length !== 2
                  || event.pitches[0].midi !== expectedAttack.lower.midi
                  || event.pitches[1].midi !== expectedAttack.upper.midi
                  || event.articulation !== (accents.has(eventIndex) ? 'accent' : undefined);
              })
            ) {
              throw invalidOctaveExercise();
            }
          });
        });
        break;
      }
      default:
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
  const attackCount = Math.min(...context.sequences.map((sequence) => sequence.attacks.length));
  const eligibleMethods = eligibleOctaveMethodIds(context.pattern, attackCount);
  if (
    context.rulesVersion !== OCTAVE_RULES.schemaVersion
    || context.selectedMethods[0] === context.selectedMethods[1]
    || context.selectedMethods.some((methodId) => !eligibleMethods.includes(methodId))
    || context.sequences.length !== context.affectedHands.length
  ) {
    throw invalidOctaveExercise();
  }
  return context.selectedMethods.map((methodId) => (
    generatedExercise(methodId, measuresForMethod(methodId, context, sourceMeasure), context, sourceMeasure)
  )) as [GeneratedPracticeExercise, GeneratedPracticeExercise];
}

export function materializeOctavePracticeAnalysis(
  analysis: string,
  sourceMeasure: ExtractedMeasure,
  context: OctavePracticeContext,
): GeneratedMeasureAnalysis {
  const normalizedAnalysis = validateAnalysisText(analysis);
  return {
    analysis: normalizedAnalysis,
    exercises: generateOctavePracticeExercises(sourceMeasure, context),
  };
}
