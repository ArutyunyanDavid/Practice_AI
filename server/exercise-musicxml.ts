import { z } from 'zod';
import { AppError } from './errors.js';
import { escapeXml } from './xml.js';
import { extractMeasureForAnalysis } from './measure.js';
import type { ExtractedMeasure } from './measure.js';
import { EXERCISE_DIVISIONS, exerciseMeter, partitionExerciseVoice, validateExerciseRhythm } from './exercise-rhythm.js';
import type { ExerciseMeter } from './exercise-rhythm.js';

const MUSICXML_DIVISIONS = EXERCISE_DIVISIONS;
const MAX_EXERCISE_XML_BYTES = 128 * 1024;
const MAX_STAFF_TICKS = MUSICXML_DIVISIONS * 8;

const RHYTHM_NAMES = [
  'whole',
  'dotted-half',
  'half',
  'dotted-quarter',
  'quarter',
  'dotted-eighth',
  'eighth',
  'dotted-16th',
  '16th',
  'dotted-32nd',
  '32nd',
  '64th',
  'half-triplet',
  'quarter-triplet',
  'eighth-triplet',
  '16th-triplet',
  '32nd-triplet',
] as const;

const TRANSFORMATIONS = [
  'voice-isolation',
  'staff-isolation',
  'rhythmic-reduction',
  'blocked-sonorities',
  'rhythmic-loop',
  'accent-variation',
  'register-loop',
  'coordination-layering',
  'custom-reduction',
] as const;

const ARTICULATIONS = [
  'none',
  'staccato',
  'staccatissimo',
  'tenuto',
  'accent',
  'marcato',
] as const;

interface RhythmDefinition {
  ticks: number;
  type: string;
  dots?: number;
  triplet?: boolean;
}

const RHYTHMS: Record<(typeof RHYTHM_NAMES)[number], RhythmDefinition> = {
  whole: { ticks: 192, type: 'whole' },
  'dotted-half': { ticks: 144, type: 'half', dots: 1 },
  half: { ticks: 96, type: 'half' },
  'dotted-quarter': { ticks: 72, type: 'quarter', dots: 1 },
  quarter: { ticks: 48, type: 'quarter' },
  'dotted-eighth': { ticks: 36, type: 'eighth', dots: 1 },
  eighth: { ticks: 24, type: 'eighth' },
  'dotted-16th': { ticks: 18, type: '16th', dots: 1 },
  '16th': { ticks: 12, type: '16th' },
  'dotted-32nd': { ticks: 9, type: '32nd', dots: 1 },
  '32nd': { ticks: 6, type: '32nd' },
  '64th': { ticks: 3, type: '64th' },
  'half-triplet': { ticks: 64, type: 'half', triplet: true },
  'quarter-triplet': { ticks: 32, type: 'quarter', triplet: true },
  'eighth-triplet': { ticks: 16, type: 'eighth', triplet: true },
  '16th-triplet': { ticks: 8, type: '16th', triplet: true },
  '32nd-triplet': { ticks: 4, type: '32nd', triplet: true },
};

const PitchSchema = z.object({
  step: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    .describe('Uppercase diatonic pitch name.'),
  alter: z.number().int().min(-2).max(2)
    .describe('Chromatic alteration in semitones: -2 through 2, with 0 for a natural pitch.'),
  octave: z.number().int().min(0).max(8)
    .describe('Scientific pitch-notation octave number.'),
}).strict();

const NotationEventSchema = z.object({
  kind: z.enum(['notes', 'rest'])
    .describe('Use notes for a note or chord and rest for silence.'),
  duration: z.enum(RHYTHM_NAMES)
    .describe('The written rhythmic value for this event.'),
  pitches: z.array(PitchSchema).max(8)
    .describe('One pitch for a note, multiple simultaneous pitches for a chord, and an empty array for a rest.'),
  articulation: z.enum(ARTICULATIONS)
    .describe('A single articulation to apply, or none.'),
}).strict();

const NotationStaffSchema = z.object({
  clef: z.enum(['treble', 'bass'])
    .describe('The clef that makes this exercise staff easiest to read.'),
  events: z.array(NotationEventSchema).min(1).max(64)
    .describe('Sequential events for this staff; pitches within one event sound as a chord.'),
}).strict();

export const AIExerciseNotationSchema = z.object({
  staves: z.array(NotationStaffSchema).min(1).max(2)
    .describe('One or two piano staves containing the complete exercise notation.'),
}).strict();

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

function sentencesIn(value: string): string[] {
  return [...sentenceSegmenter.segment(value)]
    .map(item => item.segment.trim()).filter(Boolean);
}

export const ExerciseExplanationSchema = z.string().trim().min(12).max(360).refine(value => {
  const sentences = sentencesIn(value);
  const words = value.split(/\s+/).length;
  return sentences.length >= 1 && sentences.length <= 2 && words >= 4 && words <= 40
    && sentences.every(sentence => /[.!?]$/.test(sentence)) && !/[\r\n]/.test(value);
}, 'Use one or two short sentences, with no more than forty words.');

export const ExerciseExplanationsSchema = z.array(ExerciseExplanationSchema).length(2)
  .refine(
    descriptions => descriptions.reduce((count, text) => count + sentencesIn(text).length, 0) <= 3,
    'Use two or three short sentences in total per exercise.',
  )
  .describe('Exactly two descriptions totaling two or three short sentences per exercise: What This Exercise Develops (the skill and how it helps the reported difficulty), then How to Practice (specific steps for the actual notation). Each entry has one or two sentences, at most forty words; never write four sentences overall.');

export const AIPracticeExerciseSchema = z.object({
  title: z.string().trim().min(2).max(80)
    .describe('A short title of no more than ten words and no sentence-ending punctuation.'),
  explanationSentences: ExerciseExplanationsSchema,
  transformation: z.enum(TRANSFORMATIONS)
    .describe('The principal musical transformation used to create the exercise.'),
  notation: AIExerciseNotationSchema,
}).strict();

const analysisWordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });

function analysisTextIsValid(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  const sentences = sentencesIn(text);
  const wordCount = [...analysisWordSegmenter.segment(text)]
    .filter(({ isWordLike }) => isWordLike)
    .length;
  return sentences.length >= 2
    && sentences.length <= 3
    && sentences.every((sentence) => /[.!?]["'”’)]*$/.test(sentence))
    && wordCount <= 60;
}

export const AIAnalysisTextSchema = z.string().trim().min(1).max(6_000)
  .refine(
    analysisTextIsValid,
    'Analysis must contain two or three complete sentences and no more than 60 words.',
  )
  .describe(
    'Exactly two or three short prose sentences totaling no more than 60 words, explaining why this measure is tricky in simple, natural language like a piano teacher speaking to a student.',
  );

export function validateAnalysisText(value: string): string {
  const parsed = AIAnalysisTextSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      502,
      'OPENAI_INVALID_RESPONSE',
      'OpenAI returned an analysis that must contain two or three sentences and no more than 60 words. Please try again.',
    );
  }
  return parsed.data.replace(/\s+/g, ' ').trim();
}

export const AIMeasureAnalysisSchema = z.object({
  analysis: AIAnalysisTextSchema,
  exercises: z.array(AIPracticeExerciseSchema).length(2),
}).strict();

export type AIMeasureAnalysisPlan = z.infer<typeof AIMeasureAnalysisSchema>;
export type AIExerciseNotation = z.infer<typeof AIExerciseNotationSchema>;
type AIPracticeExercise = z.infer<typeof AIPracticeExerciseSchema>;
type NotationEvent = z.infer<typeof NotationEventSchema>;
interface RenderedEvent extends Omit<NotationEvent, 'duration'> {
  rhythm: RhythmDefinition;
  tieStart: boolean;
  tieStop: boolean;
}
interface RenderedNotation {
  staves: Array<{ clef: 'treble' | 'bass'; events: RenderedEvent[] }>;
}
type Pitch = z.infer<typeof PitchSchema>;

export interface GeneratedPracticeExercise {
  title: string;
  explanationSentences: [string, string];
  musicXml: string;
}

export interface GeneratedMeasureAnalysis {
  analysis: string;
  exercises: [GeneratedPracticeExercise, GeneratedPracticeExercise];
}

interface CanonicalNote {
  staff: number;
  onsetTicks: number;
  durationTicks: number;
  pitch: { step: string; alter: number; octave: number } | null;
  chord: boolean;
  beams: CanonicalBeam[];
  ties: string[];
}

type BeamValue = 'begin' | 'continue' | 'end' | 'forward hook' | 'backward hook';

interface CanonicalBeam {
  number: number;
  value: BeamValue;
}

function invalidExercise(): AppError {
  return new AppError(
    502,
    'OPENAI_INVALID_RESPONSE',
    'OpenAI returned exercise notation that could not be validated. Please try again.',
  );
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function validateTitle(value: string): string {
  const title = normalizeSpace(value);
  const words = title.split(' ').filter(Boolean);
  if (words.length < 1 || words.length > 10 || /[.!?]/.test(title)) throw invalidExercise();
  return title;
}

function validateExplanation(value: string): string {
  const parsed = ExerciseExplanationSchema.safeParse(value);
  if (!parsed.success) throw invalidExercise();
  return normalizeSpace(parsed.data);
}

const STEP_SEMITONES: Record<Pitch['step'], number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function midiNumber(pitch: Pitch): number {
  return (pitch.octave + 1) * 12 + STEP_SEMITONES[pitch.step] + pitch.alter;
}

function pitchClass(pitch: { step: string; alter?: number }): number | null {
  if (!(pitch.step in STEP_SEMITONES)) return null;
  const semitone = STEP_SEMITONES[pitch.step as Pitch['step']] + (pitch.alter ?? 0);
  return ((semitone % 12) + 12) % 12;
}

function sourcePitchClasses(measure: ExtractedMeasure): Set<number> {
  const result = new Set<number>();
  for (const part of measure.parts) {
    for (const event of part.events) {
      if (event.kind !== 'note' || !event.pitch || typeof event.pitch !== 'object') continue;
      const sourcePitch = event.pitch as Record<string, unknown>;
      if (typeof sourcePitch.step !== 'string') continue;
      const pitch = pitchClass({
        step: sourcePitch.step,
        alter: typeof sourcePitch.alter === 'number' ? sourcePitch.alter : undefined,
      });
      if (pitch !== null) result.add(pitch);
    }
  }
  return result;
}

function validateNotation(notation: AIExerciseNotation, sourcePitches: Set<number>): void {
  let pitchedNoteCount = 0;
  let usesSourcePitch = sourcePitches.size === 0;

  for (const staff of notation.staves) {
    let staffTicks = 0;
    for (const event of staff.events) {
      const rhythm = RHYTHMS[event.duration];
      if (!rhythm) throw invalidExercise();
      staffTicks += rhythm.ticks;

      if (event.kind === 'rest') {
        if (event.pitches.length !== 0 || event.articulation !== 'none') throw invalidExercise();
        continue;
      }
      if (event.pitches.length < 1) throw invalidExercise();

      const uniquePitches = new Set<string>();
      for (const pitch of event.pitches) {
        const midi = midiNumber(pitch);
        if (midi < 21 || midi > 108) throw invalidExercise();
        const identity = `${pitch.step}:${pitch.alter}:${pitch.octave}`;
        if (uniquePitches.has(identity)) throw invalidExercise();
        uniquePitches.add(identity);
        pitchedNoteCount += 1;
        if (sourcePitches.has(pitchClass(pitch)!)) usesSourcePitch = true;
      }
    }
    if (staffTicks <= 0 || staffTicks > MAX_STAFF_TICKS) throw invalidExercise();
  }

  if (pitchedNoteCount < 2 || !usesSourcePitch) throw invalidExercise();
}

function sortedPitches(pitches: Pitch[]): Pitch[] {
  return [...pitches].sort((first, second) => midiNumber(first) - midiNumber(second));
}

function articulationXml(articulation: NotationEvent['articulation']): string | null {
  if (articulation === 'none') return null;
  if (articulation === 'marcato') return '<strong-accent type="up"/>';
  return `<${articulation}/>`;
}

function eventNotationsXml(
  event: RenderedEvent,
  tupletBoundary: 'start' | 'stop' | 'start-stop' | null,
): string {
  const marks: string[] = [];
  if (event.tieStop) marks.push('<tied type="stop"/>');
  if (event.tieStart) marks.push('<tied type="start"/>');
  const articulation = articulationXml(event.articulation);
  if (articulation) marks.push(`<articulations>${articulation}</articulations>`);
  if (tupletBoundary === 'start' || tupletBoundary === 'start-stop') marks.push('<tuplet type="start"/>');
  if (tupletBoundary === 'stop' || tupletBoundary === 'start-stop') marks.push('<tuplet type="stop"/>');
  return marks.length > 0 ? `<notations>${marks.join('')}</notations>` : '';
}

function noteXml(
  event: RenderedEvent,
  staffNumber: number,
  tupletBoundary: 'start' | 'stop' | 'start-stop' | null,
  beams: CanonicalBeam[],
): string {
  const rhythm = event.rhythm;
  const dots = '<dot/>'.repeat(rhythm.dots ?? 0);
  const timeModification = rhythm.triplet
    ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes>'
      + `<normal-type>${rhythm.type}</normal-type>${'<normal-dot/>'.repeat(rhythm.dots ?? 0)}</time-modification>`
    : '';

  if (event.kind === 'rest') {
    return [
      '<note>',
      '<rest/>',
      `<duration>${rhythm.ticks}</duration>`,
      `<voice>${staffNumber}</voice>`,
      `<type>${rhythm.type}</type>`,
      dots,
      timeModification,
      `<staff>${staffNumber}</staff>`,
      eventNotationsXml(event, tupletBoundary),
      '</note>',
    ].join('');
  }

  return sortedPitches(event.pitches).map((pitch, pitchIndex) => [
    '<note>',
    pitchIndex > 0 ? '<chord/>' : '',
    '<pitch>',
    `<step>${pitch.step}</step>`,
    pitch.alter !== 0 ? `<alter>${pitch.alter}</alter>` : '',
    `<octave>${pitch.octave}</octave>`,
    '</pitch>',
    `<duration>${rhythm.ticks}</duration>`,
    event.tieStop ? '<tie type="stop"/>' : '',
    event.tieStart ? '<tie type="start"/>' : '',
    `<voice>${staffNumber}</voice>`,
    `<type>${rhythm.type}</type>`,
    dots,
    timeModification,
    `<staff>${staffNumber}</staff>`,
    pitchIndex === 0
      ? beams.map((beam) => `<beam number="${beam.number}">${beam.value}</beam>`).join('')
      : '',
    eventNotationsXml(pitchIndex === 0 ? event : { ...event, articulation: 'none' }, pitchIndex === 0 ? tupletBoundary : null),
    '</note>',
  ].join('')).join('');
}

function beamLevel(event: RenderedEvent): number {
  if (event.kind !== 'notes') return 0;
  switch (event.rhythm.type) {
    case 'eighth': return 1;
    case '16th': return 2;
    case '32nd': return 3;
    case '64th': return 4;
    case '128th': return 5;
    default: return 0;
  }
}

function beamAssignments(events: RenderedEvent[]): CanonicalBeam[][] {
  const result = events.map<CanonicalBeam[]>(() => []);
  const levels = events.map(beamLevel);
  let runStart = 0;

  while (runStart < events.length) {
    if (levels[runStart] === 0) {
      runStart += 1;
      continue;
    }

    let runEnd = runStart + 1;
    while (runEnd < events.length && levels[runEnd] > 0) runEnd += 1;
    if (runEnd - runStart < 2) {
      runStart = runEnd;
      continue;
    }

    const maximumLevel = Math.max(...levels.slice(runStart, runEnd));
    for (let level = 1; level <= maximumLevel; level += 1) {
      let segmentStart = runStart;
      while (segmentStart < runEnd) {
        while (segmentStart < runEnd && levels[segmentStart] < level) segmentStart += 1;
        if (segmentStart >= runEnd) break;

        let segmentEnd = segmentStart + 1;
        while (segmentEnd < runEnd && levels[segmentEnd] >= level) segmentEnd += 1;
        const segmentLength = segmentEnd - segmentStart;
        if (segmentLength === 1) {
          result[segmentStart].push({
            number: level,
            value: segmentStart < runEnd - 1 ? 'forward hook' : 'backward hook',
          });
        } else {
          for (let index = segmentStart; index < segmentEnd; index += 1) {
            result[index].push({
              number: level,
              value: index === segmentStart ? 'begin' : index === segmentEnd - 1 ? 'end' : 'continue',
            });
          }
        }
        segmentStart = segmentEnd;
      }
    }
    runStart = runEnd;
  }

  return result;
}

function tupletBoundaries(events: RenderedEvent[]): Array<'start' | 'stop' | 'start-stop' | null> {
  const result: Array<'start' | 'stop' | 'start-stop' | null> = events.map(() => null);
  let index = 0;
  while (index < events.length) {
    if (!events[index].rhythm.triplet) {
      index += 1;
      continue;
    }
    const duration = events[index].rhythm.ticks;
    let end = index + 1;
    while (end < events.length && events[end].rhythm.triplet && events[end].rhythm.ticks === duration) end += 1;
    if (end - index === 1) result[index] = 'start-stop';
    else {
      result[index] = 'start';
      result[end - 1] = 'stop';
    }
    index = end;
  }
  return result;
}

function staffXml(staff: RenderedNotation['staves'][number], staffNumber: number): { xml: string; ticks: number } {
  const boundaries = tupletBoundaries(staff.events);
  const beams = beamAssignments(staff.events);
  const ticks = staff.events.reduce((total, event) => total + event.rhythm.ticks, 0);
  return {
    xml: staff.events.map((event, index) => noteXml(event, staffNumber, boundaries[index], beams[index])).join(''),
    ticks,
  };
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}

function sourceContext(measure: ExtractedMeasure): Record<string, unknown> {
  const part = measure.parts[0];
  const attributes = part?.events.find((event) => event.kind === 'attributes');
  const context: Record<string, unknown> = { ...(part?.startingContext ?? {}) };
  if (!attributes || typeof attributes !== 'object') return context;

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
      const existingIndex = merged.findIndex((candidate) => candidate.staff === update.staff);
      if (existingIndex >= 0) merged[existingIndex] = update;
      else merged.push(update);
    }
    context[key] = merged;
  }
  return context;
}

function notationMeasures(notation: AIExerciseNotation, meter: ExerciseMeter): RenderedNotation[] {
  const voices = notation.staves.map(staff => {
    let onsetTicks = 0;
    return staff.events.map(event => {
      const rhythm = RHYTHMS[event.duration];
      const timed = {
        event, onsetTicks, rest: event.kind === 'rest',
        duration: { ...rhythm, ...(rhythm.triplet ? { timeModification: { actualNotes: 3, normalNotes: 2 } } : {}) },
      };
      onsetTicks += rhythm.ticks;
      return timed;
    });
  });
  const totalTicks = Math.max(...voices.flatMap(events => events.map(event => event.onsetTicks + event.duration.ticks)));
  const barCount = Math.ceil(totalTicks / meter.ticks);
  const barsByStaff = voices.map(events => partitionExerciseVoice(events, meter.ticks, barCount));
  return Array.from({ length: barCount }, (_, index) => ({
    staves: notation.staves.map((staff, staffIndex) => ({
      clef: staff.clef,
      events: barsByStaff[staffIndex][index].map(fragment => ({
        kind: fragment.source?.event.kind ?? 'rest',
        pitches: fragment.source?.event.pitches ?? [],
        articulation: fragment.tieStop ? 'none' : fragment.source?.event.articulation ?? 'none',
        rhythm: { ...fragment.duration, triplet: Boolean(fragment.duration.timeModification) },
        tieStart: fragment.tieStart, tieStop: fragment.tieStop,
      })),
    })),
  }));
}

function sourceKeyXml(measure: ExtractedMeasure): string {
  const context = sourceContext(measure);
  const keys = asRecordArray(context?.keys);
  const key = keys.find((candidate) => candidate.staff === undefined || candidate.staff === 1) ?? keys[0];
  const fifths = typeof key?.fifths === 'number' && Number.isInteger(key.fifths) && key.fifths >= -7 && key.fifths <= 7
    ? key.fifths
    : 0;
  const mode = typeof key?.mode === 'string' && /^[a-z-]{2,20}$/i.test(key.mode)
    ? `<mode>${escapeXml(key.mode.toLowerCase())}</mode>`
    : '';
  return `<key><fifths>${fifths}</fifths>${mode}</key>`;
}

function clefsXml(notation: AIExerciseNotation): string {
  return notation.staves.map((staff, index) => {
    const sign = staff.clef === 'treble' ? 'G' : 'F';
    const line = staff.clef === 'treble' ? 2 : 4;
    const number = notation.staves.length > 1 ? ` number="${index + 1}"` : '';
    return `<clef${number}><sign>${sign}</sign><line>${line}</line></clef>`;
  }).join('');
}

function expectedCanonicalNotes(notation: RenderedNotation): CanonicalNote[] {
  const result: CanonicalNote[] = [];
  notation.staves.forEach((staff, staffIndex) => {
    let onsetTicks = 0;
    const beams = beamAssignments(staff.events);
    staff.events.forEach((event, eventIndex) => {
      const durationTicks = event.rhythm.ticks;
      if (event.kind === 'rest') {
        result.push({ staff: staffIndex + 1, onsetTicks, durationTicks, pitch: null, chord: false, beams: [], ties: [] });
      } else {
        sortedPitches(event.pitches).forEach((pitch, pitchIndex) => {
          result.push({
            staff: staffIndex + 1,
            onsetTicks,
            durationTicks,
            pitch: { step: pitch.step, alter: pitch.alter, octave: pitch.octave },
            chord: pitchIndex > 0,
            beams: pitchIndex === 0 ? beams[eventIndex] : [],
            ties: [...(event.tieStart ? ['start'] : []), ...(event.tieStop ? ['stop'] : [])],
          });
        });
      }
      onsetTicks += durationTicks;
    });
  });
  return result;
}

function canonicalBeams(value: unknown): CanonicalBeam[] {
  if (!Array.isArray(value)) throw invalidExercise();
  return value.map((beam) => {
    if (!beam || typeof beam !== 'object') throw invalidExercise();
    const number = (beam as Record<string, unknown>).number;
    const beamValue = (beam as Record<string, unknown>).value;
    if (
      typeof number !== 'number'
      || !Number.isInteger(number)
      || number < 1
      || number > 5
      || !['begin', 'continue', 'end', 'forward hook', 'backward hook'].includes(String(beamValue))
    ) {
      throw invalidExercise();
    }
    return { number, value: beamValue as BeamValue };
  });
}

function actualCanonicalNotes(xml: string, measureIndex = 0): {
  notes: CanonicalNote[];
  context: Record<string, unknown>;
  barlines: Array<{ location: unknown; style: unknown }>;
} {
  const extracted = extractMeasureForAnalysis(xml, measureIndex);
  if (extracted.scoreFormat !== 'partwise' || extracted.parts.length !== 1) throw invalidExercise();
  const part = extracted.parts[0];
  const attributesEvent = part.events.find((event) => event.kind === 'attributes');
  const notes = part.events.filter((event) => event.kind === 'note').map((event) => {
    const pitch = event.pitch && typeof event.pitch === 'object'
      ? event.pitch as Record<string, unknown>
      : null;
    if (event.durationQuarterNotes === undefined || typeof event.durationQuarterNotes !== 'number') {
      throw invalidExercise();
    }
    return {
      staff: typeof event.staff === 'number' ? event.staff : 1,
      onsetTicks: Math.round(Number(event.onsetQuarterNotes ?? 0) * MUSICXML_DIVISIONS),
      durationTicks: Math.round(event.durationQuarterNotes * MUSICXML_DIVISIONS),
      pitch: pitch && typeof pitch.step === 'string' && typeof pitch.octave === 'number'
        ? {
            step: pitch.step,
            alter: typeof pitch.alter === 'number' ? pitch.alter : 0,
            octave: pitch.octave,
          }
        : null,
      chord: Boolean(event.chord),
      beams: canonicalBeams(event.beams),
      ties: [...new Set(asRecordArray(event.ties).map(tie => String((tie.attributes as Record<string, unknown>).type)))].sort(),
    } satisfies CanonicalNote;
  });
  return {
    notes,
    barlines: part.events
      .filter((event) => event.kind === 'barline')
      .map((event) => ({ location: event.location, style: event.style })),
    context: {
      ...part.startingContext,
      ...(attributesEvent && typeof attributesEvent === 'object' ? attributesEvent : {}),
    },
  };
}

export function validateGeneratedExerciseMusicXml(xml: string, notation: AIExerciseNotation): void {
  if (
    Buffer.byteLength(xml, 'utf8') > MAX_EXERCISE_XML_BYTES
    || /<!DOCTYPE\b|<!ENTITY\b/i.test(xml)
  ) {
    throw invalidExercise();
  }
  const actual = actualCanonicalNotes(xml);
  if (notation.staves.every(staff => staff.events.every(event => event.kind === 'rest'))) throw invalidExercise();
  const measures = notationMeasures(notation, exerciseMeter(asRecordArray(actual.context.times)[0]));
  if ((xml.match(/<measure\b/g) ?? []).length !== measures.length) throw invalidExercise();
  measures.forEach((measure, index) => {
    const bar = index === 0 ? actual : actualCanonicalNotes(xml, index);
    if (JSON.stringify(bar.notes) !== JSON.stringify(expectedCanonicalNotes(measure))) throw invalidExercise();
    if (JSON.stringify(bar.barlines) !== JSON.stringify([
      ...(index === 0 ? [{ location: 'left', style: 'heavy-light' }] : []),
      { location: 'right', style: index === measures.length - 1 ? 'light-heavy' : 'regular' },
    ])) throw invalidExercise();
  });
  try { validateExerciseRhythm(xml); } catch { throw invalidExercise(); }
  if (actual.context.divisions !== MUSICXML_DIVISIONS) throw invalidExercise();
  if (notation.staves.length > 1 && actual.context.staves !== notation.staves.length) throw invalidExercise();

  const clefs = asRecordArray(actual.context.clefs);
  notation.staves.forEach((staff, index) => {
    const expectedSign = staff.clef === 'treble' ? 'G' : 'F';
    const actualClef = clefs.find((clef) => clef.staff === index + 1)
      ?? (notation.staves.length === 1 ? clefs[0] : undefined);
    if (actualClef?.sign !== expectedSign) throw invalidExercise();
  });
}

export function generateExerciseMusicXml(
  title: string,
  notation: AIExerciseNotation,
  sourceMeasure: ExtractedMeasure,
): string {
  const meter = exerciseMeter(asRecordArray(sourceContext(sourceMeasure).times)[0]);
  const measures = notationMeasures(notation, meter);
  const measureXml = measures.map((measure, measureIndex) => {
    const contents = measure.staves.map((staff, index) => (
      (index > 0 ? `<backup><duration>${meter.ticks}</duration></backup>` : '') + staffXml(staff, index + 1).xml
    )).join('');
    return [
      `<measure number="${measureIndex + 1}">`,
      measureIndex === 0 ? [
        '<attributes>', `<divisions>${MUSICXML_DIVISIONS}</divisions>`, sourceKeyXml(sourceMeasure), meter.xml,
        notation.staves.length > 1 ? `<staves>${notation.staves.length}</staves>` : '',
        clefsXml(notation), '</attributes>',
        '<barline location="left"><bar-style>heavy-light</bar-style></barline>',
      ].join('') : '',
      contents,
      `<barline location="right"><bar-style>${measureIndex === measures.length - 1 ? 'light-heavy' : 'regular'}</bar-style></barline>`,
      '</measure>',
    ].join('');
  }).join('');

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<score-partwise version="4.0">',
    `<work><work-title>${escapeXml(title)}</work-title></work>`,
    '<part-list><score-part id="P1"><part-name>Practice Exercise</part-name></score-part></part-list>',
    `<part id="P1">${measureXml}</part></score-partwise>`,
  ].join('');

  validateGeneratedExerciseMusicXml(xml, notation);
  return xml;
}

function materializeExercise(
  exercise: AIPracticeExercise,
  sourceMeasure: ExtractedMeasure,
  sourcePitches: Set<number>,
): GeneratedPracticeExercise {
  const title = validateTitle(exercise.title);
  const explanationSentences = exercise.explanationSentences.map(validateExplanation) as [string, string];
  validateNotation(exercise.notation, sourcePitches);
  return {
    title,
    explanationSentences,
    musicXml: generateExerciseMusicXml(title, exercise.notation, sourceMeasure),
  };
}

export function materializePracticeExercise(
  exercise: AIPracticeExercise,
  sourceMeasure: ExtractedMeasure,
): GeneratedPracticeExercise {
  return materializeExercise(exercise, sourceMeasure, sourcePitchClasses(sourceMeasure));
}

export function materializeMeasureAnalysis(
  plan: AIMeasureAnalysisPlan,
  sourceMeasure: ExtractedMeasure,
): GeneratedMeasureAnalysis {
  const analysis = validateAnalysisText(plan.analysis);
  if (plan.exercises.length !== 2) throw invalidExercise();
  if (JSON.stringify(plan.exercises[0].notation) === JSON.stringify(plan.exercises[1].notation)) {
    throw new AppError(502, 'EXERCISES_REPEATED', 'The exercises use the same musical pattern. Please try again.');
  }

  const sourcePitches = sourcePitchClasses(sourceMeasure);
  const first = materializeExercise(plan.exercises[0], sourceMeasure, sourcePitches);
  const second = materializeExercise(plan.exercises[1], sourceMeasure, sourcePitches);
  if (first.title.toLocaleLowerCase() === second.title.toLocaleLowerCase()) throw invalidExercise();

  return {
    analysis,
    exercises: [first, second],
  };
}
