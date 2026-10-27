import { z } from 'zod';
import { AppError } from './errors.js';
import { extractMeasureForAnalysis } from './measure.js';
import type { ExtractedMeasure } from './measure.js';

const MUSICXML_DIVISIONS = 48;
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

export const AIPracticeExerciseSchema = z.object({
  title: z.string().trim().min(2).max(80)
    .describe('A short title of no more than ten words and no sentence-ending punctuation.'),
  explanationSentences: z.array(z.string().trim().min(12).max(240)).length(2)
    .describe('Exactly two simple sentences. The first explains the target; the second explains how to practice it.'),
  transformation: z.enum(TRANSFORMATIONS)
    .describe('The principal musical transformation used to create the exercise.'),
  notation: AIExerciseNotationSchema,
}).strict();

const analysisSentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const analysisWordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });

function analysisTextIsValid(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  const sentences = [...analysisSentenceSegmenter.segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
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

function validateSimpleSentence(value: string): string {
  const sentence = normalizeSpace(value);
  const words = sentence.slice(0, -1).split(' ').filter(Boolean);
  if (
    /[\r\n]/.test(value)
    || sentence.includes(';')
    || !sentence.endsWith('.')
    || /[.!?]/.test(sentence.slice(0, -1))
    || words.length < 4
    || words.length > 20
  ) {
    throw invalidExercise();
  }
  return sentence;
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
  event: NotationEvent,
  tupletBoundary: 'start' | 'stop' | 'start-stop' | null,
): string {
  const marks: string[] = [];
  const articulation = articulationXml(event.articulation);
  if (articulation) marks.push(`<articulations>${articulation}</articulations>`);
  if (tupletBoundary === 'start' || tupletBoundary === 'start-stop') marks.push('<tuplet type="start"/>');
  if (tupletBoundary === 'stop' || tupletBoundary === 'start-stop') marks.push('<tuplet type="stop"/>');
  return marks.length > 0 ? `<notations>${marks.join('')}</notations>` : '';
}

function noteXml(
  event: NotationEvent,
  staffNumber: number,
  tupletBoundary: 'start' | 'stop' | 'start-stop' | null,
  beams: CanonicalBeam[],
): string {
  const rhythm = RHYTHMS[event.duration];
  const dots = '<dot/>'.repeat(rhythm.dots ?? 0);
  const timeModification = rhythm.triplet
    ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes>'
      + `<normal-type>${rhythm.type}</normal-type></time-modification>`
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
    `<voice>${staffNumber}</voice>`,
    `<type>${rhythm.type}</type>`,
    dots,
    timeModification,
    `<staff>${staffNumber}</staff>`,
    pitchIndex === 0
      ? beams.map((beam) => `<beam number="${beam.number}">${beam.value}</beam>`).join('')
      : '',
    pitchIndex === 0 ? eventNotationsXml(event, tupletBoundary) : '',
    '</note>',
  ].join('')).join('');
}

function beamLevel(event: NotationEvent): number {
  if (event.kind !== 'notes') return 0;
  switch (RHYTHMS[event.duration].type) {
    case 'eighth': return 1;
    case '16th': return 2;
    case '32nd': return 3;
    case '64th': return 4;
    default: return 0;
  }
}

function beamAssignments(events: NotationEvent[]): CanonicalBeam[][] {
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

function tupletBoundaries(events: NotationEvent[]): Array<'start' | 'stop' | 'start-stop' | null> {
  const result: Array<'start' | 'stop' | 'start-stop' | null> = events.map(() => null);
  let index = 0;
  while (index < events.length) {
    if (!RHYTHMS[events[index].duration].triplet) {
      index += 1;
      continue;
    }
    const duration = events[index].duration;
    let end = index + 1;
    while (end < events.length && events[end].duration === duration) end += 1;
    if (end - index === 1) result[index] = 'start-stop';
    else {
      result[index] = 'start';
      result[end - 1] = 'stop';
    }
    index = end;
  }
  return result;
}

function staffXml(staff: AIExerciseNotation['staves'][number], staffNumber: number): { xml: string; ticks: number } {
  const boundaries = tupletBoundaries(staff.events);
  const beams = beamAssignments(staff.events);
  const ticks = staff.events.reduce((total, event) => total + RHYTHMS[event.duration].ticks, 0);
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

function sourceTimeXml(measure: ExtractedMeasure): string {
  const context = sourceContext(measure);
  const time = asRecordArray(context?.times)[0];
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

function expectedCanonicalNotes(notation: AIExerciseNotation): CanonicalNote[] {
  const result: CanonicalNote[] = [];
  notation.staves.forEach((staff, staffIndex) => {
    let onsetTicks = 0;
    const beams = beamAssignments(staff.events);
    staff.events.forEach((event, eventIndex) => {
      const durationTicks = RHYTHMS[event.duration].ticks;
      if (event.kind === 'rest') {
        result.push({ staff: staffIndex + 1, onsetTicks, durationTicks, pitch: null, chord: false, beams: [] });
      } else {
        sortedPitches(event.pitches).forEach((pitch, pitchIndex) => {
          result.push({
            staff: staffIndex + 1,
            onsetTicks,
            durationTicks,
            pitch: { step: pitch.step, alter: pitch.alter, octave: pitch.octave },
            chord: pitchIndex > 0,
            beams: pitchIndex === 0 ? beams[eventIndex] : [],
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
      || number > 4
      || !['begin', 'continue', 'end', 'forward hook', 'backward hook'].includes(String(beamValue))
    ) {
      throw invalidExercise();
    }
    return { number, value: beamValue as BeamValue };
  });
}

function actualCanonicalNotes(xml: string): {
  notes: CanonicalNote[];
  context: Record<string, unknown>;
  barlines: Array<{ location: unknown; style: unknown }>;
} {
  const extracted = extractMeasureForAnalysis(xml, 0);
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
  const expected = expectedCanonicalNotes(notation);
  if (JSON.stringify(actual.notes) !== JSON.stringify(expected)) throw invalidExercise();
  if (actual.notes.every((note) => note.pitch === null)) throw invalidExercise();
  if (JSON.stringify(actual.barlines) !== JSON.stringify([
    { location: 'left', style: 'heavy-light' },
    { location: 'right', style: 'light-heavy' },
  ])) throw invalidExercise();
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
  const renderedStaves = notation.staves.map((staff, index) => staffXml(staff, index + 1));
  const measureContents: string[] = [];
  renderedStaves.forEach((staff, index) => {
    if (index > 0) measureContents.push(`<backup><duration>${renderedStaves[index - 1].ticks}</duration></backup>`);
    measureContents.push(staff.xml);
  });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<score-partwise version="4.0">',
    `<work><work-title>${escapeXml(title)}</work-title></work>`,
    '<part-list><score-part id="P1"><part-name>Practice Exercise</part-name></score-part></part-list>',
    '<part id="P1"><measure number="1" implicit="yes">',
    '<attributes>',
    `<divisions>${MUSICXML_DIVISIONS}</divisions>`,
    sourceKeyXml(sourceMeasure),
    sourceTimeXml(sourceMeasure),
    notation.staves.length > 1 ? `<staves>${notation.staves.length}</staves>` : '',
    clefsXml(notation),
    '</attributes>',
    '<barline location="left"><bar-style>heavy-light</bar-style></barline>',
    measureContents.join(''),
    '<barline location="right"><bar-style>light-heavy</bar-style></barline>',
    '</measure></part></score-partwise>',
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
  const explanationSentences = exercise.explanationSentences.map(validateSimpleSentence) as [string, string];
  validateNotation(exercise.notation, sourcePitches);
  return {
    title,
    explanationSentences,
    musicXml: generateExerciseMusicXml(title, exercise.notation, sourceMeasure),
  };
}

export function materializeMeasureAnalysis(
  plan: AIMeasureAnalysisPlan,
  sourceMeasure: ExtractedMeasure,
): GeneratedMeasureAnalysis {
  const analysis = validateAnalysisText(plan.analysis);
  if (plan.exercises.length !== 2) throw invalidExercise();
  if (plan.exercises[0].transformation === plan.exercises[1].transformation) throw invalidExercise();
  if (JSON.stringify(plan.exercises[0].notation) === JSON.stringify(plan.exercises[1].notation)) {
    throw invalidExercise();
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
