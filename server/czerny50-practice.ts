import { z } from 'zod';
import { AppError } from './errors.js';
import { AIAnalysisTextSchema, validateAnalysisText } from './exercise-musicxml.js';
import type { GeneratedMeasureAnalysis, GeneratedPracticeExercise } from './exercise-musicxml.js';
import { extractMeasureForAnalysis } from './measure.js';
import type { ExtractedMeasure, ExtractedMeasurePart } from './measure.js';
import {
  CZERNY50_METHOD_IDS,
  CZERNY50_SCORE_FILENAME,
  getCzerny50Method,
  getCzerny50PracticeRules as getCanonicalCzerny50Rules,
  getCzerny50RulesFileReadCount as getCanonicalCzerny50RulesFileReadCount,
} from './czerny50-rules.js';
import type {
  Czerny50DurationId,
  Czerny50MethodId,
  Czerny50PracticeMethod,
} from './czerny50-rules.js';

const Czerny50MethodIdSchema = z.enum(CZERNY50_METHOD_IDS);

export const AICzerny50AnalysisSchema = z.object({
  analysis: AIAnalysisTextSchema,
  passageId: z.string().regex(/^czerny50-passage-[1-9]\d*$/).describe(
    'One passage identifier from the supplied Czerny Etude No. 50 candidates.',
  ),
  methodIds: z.array(Czerny50MethodIdSchema).length(2).describe(
    'Exactly two allowed method identifiers. They must be distinct.',
  ),
}).strict();

export type AICzerny50Analysis = z.infer<typeof AICzerny50AnalysisSchema>;
export type Czerny50Hand = 'right' | 'left';

export interface Czerny50Pitch {
  step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  alter: number;
  octave: number;
}

export interface Czerny50Passage {
  id: string;
  partId: string;
  partName: string;
  partIndex: number;
  sourceStaff: 1 | 2;
  voice: string;
  hand: Czerny50Hand;
  pitches: [
    Czerny50Pitch,
    Czerny50Pitch,
    Czerny50Pitch,
    Czerny50Pitch,
    Czerny50Pitch,
    Czerny50Pitch,
    Czerny50Pitch,
    Czerny50Pitch,
  ];
  sourceOrders: [number, number, number, number, number, number, number, number];
  startOnsetQuarterNotes: number;
  endOnsetQuarterNotes: number;
}

export interface Czerny50PracticeContext {
  rulesVersion: number;
  scoreFilename: typeof CZERNY50_SCORE_FILENAME;
  passages: Czerny50Passage[];
}

interface CandidateNote {
  pitch: Czerny50Pitch;
  order: number;
  onsetQuarterNotes: number;
  durationQuarterNotes: number;
}

interface DurationDefinition {
  ticks: number;
  type: '16th' | 'eighth';
  dots: number;
}

type Czerny50BeamValue = 'begin' | 'continue' | 'end' | 'forward hook' | 'backward hook';

interface Czerny50Beam {
  number: 1 | 2;
  value: Czerny50BeamValue;
}

const RULES = getCanonicalCzerny50Rules();
const DIVISIONS = 4;
const MAX_EXERCISE_XML_BYTES = 128 * 1024;
const MAX_PASSAGES_PER_STREAM = 16;
const MAX_PASSAGES_PER_MEASURE = 64;
const TIMELINE_TOLERANCE = 0.000_01;
const DURATION_DEFINITIONS: Record<Czerny50DurationId, DurationDefinition> = {
  sixteenth: { ticks: 1, type: '16th', dots: 0 },
  eighth: { ticks: 2, type: 'eighth', dots: 0 },
  'dotted-eighth': { ticks: 3, type: 'eighth', dots: 1 },
};

export function getCzerny50PracticeRules(): Readonly<typeof RULES> {
  return RULES;
}

export function getCzerny50RulesFileReadCount(): number {
  return getCanonicalCzerny50RulesFileReadCount();
}

function invalidCzerny50Response(): AppError {
  return new AppError(
    502,
    'OPENAI_INVALID_RESPONSE',
    'OpenAI returned an invalid Czerny Etude No. 50 exercise selection. Please try again.',
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.map(asRecord).filter((candidate): candidate is Record<string, unknown> => candidate !== null);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parsePitch(value: unknown): Czerny50Pitch | null {
  const pitch = asRecord(value);
  const step = pitch?.step;
  const alter = pitch?.alter ?? 0;
  const octave = pitch?.octave;
  if (
    typeof step !== 'string'
    || !['A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(step)
    || !Number.isInteger(alter)
    || Number(alter) < -4
    || Number(alter) > 4
    || !Number.isInteger(octave)
    || Number(octave) < -1
    || Number(octave) > 9
  ) {
    return null;
  }
  return {
    step: step as Czerny50Pitch['step'],
    alter: Number(alter),
    octave: Number(octave),
  };
}

function hasTieStop(value: unknown): boolean {
  return asRecordArray(value).some((tie) => {
    const attributes = asRecord(tie.attributes);
    return attributes?.type === 'stop' || tie.type === 'stop' || tie.value === 'stop';
  });
}

function noteStreamKey(event: Record<string, unknown>): string | null {
  const staff = finiteNumber(event.staff) ?? 1;
  const voice = typeof event.voice === 'string' ? event.voice.trim() : '1';
  if ((staff !== 1 && staff !== 2) || !voice || voice.length > 40) return null;
  return `${staff}\u0000${voice}`;
}

function candidateSegments(events: Array<Record<string, unknown>>): CandidateNote[][] {
  const pitchedCountByOnset = new Map<number, number>();
  for (const event of events) {
    const onset = finiteNumber(event.onsetQuarterNotes);
    if (event.kind === 'note' && onset !== null && parsePitch(event.pitch)) {
      pitchedCountByOnset.set(onset, (pitchedCountByOnset.get(onset) ?? 0) + 1);
    }
  }

  const segments: CandidateNote[][] = [];
  let current: CandidateNote[] = [];
  const flush = () => {
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (const event of events) {
    const pitch = parsePitch(event.pitch);
    const order = finiteNumber(event.order);
    const onset = finiteNumber(event.onsetQuarterNotes);
    const duration = finiteNumber(event.durationQuarterNotes);
    const isChordAttack = Boolean(event.chord)
      || (onset !== null && (pitchedCountByOnset.get(onset) ?? 0) > 1);
    if (
      event.kind !== 'note'
      || !pitch
      || order === null
      || !Number.isSafeInteger(order)
      || onset === null
      || duration === null
      || duration <= 0
      || event.rest !== undefined
      || event.grace !== undefined
      || hasTieStop(event.ties)
      || isChordAttack
    ) {
      flush();
      continue;
    }
    const previous = current[current.length - 1];
    if (
      previous
      && Math.abs(onset - (previous.onsetQuarterNotes + previous.durationQuarterNotes)) > TIMELINE_TOLERANCE
    ) {
      flush();
    }
    current.push({
      pitch,
      order,
      onsetQuarterNotes: onset,
      durationQuarterNotes: duration,
    });
  }
  flush();
  return segments;
}

function passagesForPart(part: ExtractedMeasurePart, partIndex: number): Omit<Czerny50Passage, 'id'>[] {
  const streams = new Map<string, Array<Record<string, unknown>>>();
  for (const event of part.events) {
    if (event.kind !== 'note') continue;
    const key = noteStreamKey(event);
    if (!key) continue;
    const stream = streams.get(key) ?? [];
    stream.push(event);
    streams.set(key, stream);
  }

  const passages: Omit<Czerny50Passage, 'id'>[] = [];
  for (const [key, stream] of streams) {
    const [staffText, voice] = key.split('\u0000');
    const sourceStaff = Number(staffText) as 1 | 2;
    stream.sort((first, second) => (
      (finiteNumber(first.order) ?? 0) - (finiteNumber(second.order) ?? 0)
    ));
    let streamPassageCount = 0;
    passageSegments:
    for (const segment of candidateSegments(stream)) {
      for (let start = 0; start <= segment.length - RULES.scope.passageNoteCount; start += 1) {
        if (streamPassageCount >= MAX_PASSAGES_PER_STREAM) break passageSegments;
        const window = segment.slice(start, start + RULES.scope.passageNoteCount);
        const pitches = window.map((note) => ({ ...note.pitch })) as Czerny50Passage['pitches'];
        const sourceOrders = window.map((note) => note.order) as Czerny50Passage['sourceOrders'];
        passages.push({
          partId: part.id,
          partName: part.name,
          partIndex,
          sourceStaff,
          voice,
          hand: sourceStaff === 1 ? RULES.detection.staffOneHand : RULES.detection.staffTwoHand,
          pitches,
          sourceOrders,
          startOnsetQuarterNotes: window[0].onsetQuarterNotes,
          endOnsetQuarterNotes: window[window.length - 1].onsetQuarterNotes,
        });
        streamPassageCount += 1;
      }
    }
  }
  return passages;
}

export function detectCzerny50Passage(
  scoreFilename: string,
  measure: ExtractedMeasure,
): Czerny50PracticeContext | null {
  if (scoreFilename !== CZERNY50_SCORE_FILENAME) return null;
  const candidates = measure.parts.flatMap(passagesForPart).slice(0, MAX_PASSAGES_PER_MEASURE);
  if (candidates.length === 0) return null;
  return {
    rulesVersion: RULES.schemaVersion,
    scoreFilename: CZERNY50_SCORE_FILENAME,
    passages: candidates.map((passage, index) => ({
      id: `czerny50-passage-${index + 1}`,
      ...passage,
    })),
  };
}

export function czerny50PracticePromptSummary(
  context: Czerny50PracticeContext,
): Record<string, unknown> {
  return {
    rulesVersion: context.rulesVersion,
    scoreFilename: context.scoreFilename,
    requiredSelection: {
      passageCount: 1,
      methodCount: 2,
      distinctMethods: true,
    },
    passages: context.passages.map((passage) => ({
      id: passage.id,
      hand: passage.hand,
      staff: passage.sourceStaff,
      pitches: passage.pitches.map((pitch) => ({ ...pitch })),
    })),
    methods: RULES.methods.map((method) => ({
      id: method.id,
      title: method.title,
      summary: method.summary,
      meter: `${method.meter.beats}/${method.meter.beatType}`,
    })),
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function contextValues(
  sourceMeasure: ExtractedMeasure,
  passage: Czerny50Passage,
  field: 'keys' | 'clefs',
): Array<Record<string, unknown>> {
  const part = sourceMeasure.parts[passage.partIndex];
  if (!part || part.id !== passage.partId) throw invalidCzerny50Response();
  const values = asRecordArray(part.startingContext[field]);
  for (const event of part.events) {
    if (event.kind !== 'attributes') continue;
    const order = finiteNumber(event.order);
    if (order !== null && order > passage.sourceOrders[0]) break;
    const updates = asRecordArray(event[field]);
    for (const update of updates) {
      const updateStaff = finiteNumber(update.staff);
      const existingIndex = values.findIndex((candidate) => finiteNumber(candidate.staff) === updateStaff);
      if (existingIndex >= 0) values[existingIndex] = update;
      else values.push(update);
    }
  }
  return values;
}

function sourceKeyXml(sourceMeasure: ExtractedMeasure, passage: Czerny50Passage): string {
  const keys = contextValues(sourceMeasure, passage, 'keys');
  const key = [...keys].reverse().find((candidate) => finiteNumber(candidate.staff) === passage.sourceStaff)
    ?? [...keys].reverse().find((candidate) => candidate.staff === undefined)
    ?? keys[keys.length - 1];
  const fifths = Number.isInteger(key?.fifths)
    && Number(key?.fifths) >= -7
    && Number(key?.fifths) <= 7
    ? Number(key?.fifths)
    : 0;
  const mode = typeof key?.mode === 'string' && /^[a-z-]{2,20}$/i.test(key.mode)
    ? `<mode>${escapeXml(key.mode.toLowerCase())}</mode>`
    : '';
  return `<key><fifths>${fifths}</fifths>${mode}</key>`;
}

function sourceClefXml(sourceMeasure: ExtractedMeasure, passage: Czerny50Passage): string {
  const clefs = contextValues(sourceMeasure, passage, 'clefs');
  const clef = [...clefs].reverse().find((candidate) => finiteNumber(candidate.staff) === passage.sourceStaff)
    ?? [...clefs].reverse().find((candidate) => candidate.staff === undefined)
    ?? clefs[clefs.length - 1];
  const fallback = passage.hand === 'right'
    ? { sign: 'G', line: 2 }
    : { sign: 'F', line: 4 };
  const sign = typeof clef?.sign === 'string' && ['G', 'F', 'C'].includes(clef.sign)
    ? clef.sign
    : fallback.sign;
  const line = Number.isInteger(clef?.line) && Number(clef?.line) >= 1 && Number(clef?.line) <= 5
    ? Number(clef?.line)
    : fallback.line;
  const octaveChange = Number.isInteger(clef?.octaveChange)
    && Number(clef?.octaveChange) >= -2
    && Number(clef?.octaveChange) <= 2
    && Number(clef?.octaveChange) !== 0
    ? `<clef-octave-change>${Number(clef?.octaveChange)}</clef-octave-change>`
    : '';
  return `<clef><sign>${sign}</sign><line>${line}</line>${octaveChange}</clef>`;
}

function pitchXml(pitch: Czerny50Pitch): string {
  return [
    '<pitch>',
    `<step>${pitch.step}</step>`,
    `<alter>${pitch.alter}</alter>`,
    `<octave>${pitch.octave}</octave>`,
    '</pitch>',
  ].join('');
}

function secondaryBeamValue(
  durations: readonly Czerny50DurationId[],
  noteIndex: number,
  meter: Readonly<Czerny50PracticeMethod['meter']>,
): Czerny50BeamValue | null {
  if (durations[noteIndex] !== 'sixteenth') return null;
  const onsetTicks = durations.slice(0, noteIndex)
    .reduce((total, durationId) => total + DURATION_DEFINITIONS[durationId].ticks, 0);
  const compoundBeatTicks = DIVISIONS * 3 / 2;
  const primaryBeatTicks = meter.beatType === 8 && meter.beats % 3 === 0
    ? compoundBeatTicks
    : DIVISIONS;
  const nextOnsetTicks = onsetTicks + DURATION_DEFINITIONS[durations[noteIndex]].ticks;
  const previousIsSixteenth = durations[noteIndex - 1] === 'sixteenth'
    && onsetTicks % primaryBeatTicks !== 0;
  const nextIsSixteenth = durations[noteIndex + 1] === 'sixteenth'
    && nextOnsetTicks % primaryBeatTicks !== 0;
  if (!previousIsSixteenth && nextIsSixteenth) return 'begin';
  if (previousIsSixteenth && nextIsSixteenth) return 'continue';
  if (previousIsSixteenth) return 'end';
  return onsetTicks % primaryBeatTicks === 0 ? 'forward hook' : 'backward hook';
}

function noteBeams(
  durations: readonly Czerny50DurationId[],
  noteIndex: number,
  meter: Readonly<Czerny50PracticeMethod['meter']>,
): Czerny50Beam[] {
  const primary: Czerny50Beam = {
    number: 1,
    value: noteIndex === 0
      ? 'begin'
      : noteIndex === durations.length - 1
        ? 'end'
        : 'continue',
  };
  const secondaryValue = secondaryBeamValue(durations, noteIndex, meter);
  return secondaryValue
    ? [primary, { number: 2, value: secondaryValue }]
    : [primary];
}

function beamsXml(beams: readonly Czerny50Beam[]): string {
  return beams.map((beam) => `<beam number="${beam.number}">${beam.value}</beam>`).join('');
}

function noteXml(
  pitch: Czerny50Pitch,
  durationId: Czerny50DurationId,
  beams: readonly Czerny50Beam[],
): string {
  const duration = DURATION_DEFINITIONS[durationId];
  return [
    '<note>',
    pitchXml(pitch),
    `<duration>${duration.ticks}</duration>`,
    '<voice>1</voice>',
    `<type>${duration.type}</type>`,
    duration.dots === 1 ? '<dot/>' : '',
    '<staff>1</staff>',
    beamsXml(beams),
    '</note>',
  ].join('');
}

function directionXml(method: Readonly<Czerny50PracticeMethod>): string {
  return method.directionAboveExercise
    ? `<direction placement="above"><direction-type><words>${escapeXml(method.directionAboveExercise)}</words></direction-type></direction>`
    : '';
}

function handLabel(hand: Czerny50Hand): string {
  return hand === 'right' ? 'Right Hand' : 'Left Hand';
}

function exerciseTitle(method: Readonly<Czerny50PracticeMethod>, passage: Czerny50Passage): string {
  return `${handLabel(passage.hand)} - ${method.title}`;
}

function generatedMeasurePart(xml: string, measureIndex: number): ExtractedMeasurePart {
  const extracted = extractMeasureForAnalysis(xml, measureIndex);
  if (extracted.scoreFormat !== 'partwise' || extracted.parts.length !== 1) {
    throw invalidCzerny50Response();
  }
  return extracted.parts[0];
}

function canonicalGeneratedNotes(part: ExtractedMeasurePart): Array<{
  pitch: Czerny50Pitch;
  durationTicks: number;
  staff: number;
  voice: string;
  chord: boolean;
  beams: Czerny50Beam[];
}> {
  return part.events
    .filter((event) => event.kind === 'note')
    .map((event) => {
      const pitch = parsePitch(event.pitch);
      const durationDivisions = finiteNumber(event.durationDivisions);
      if (!pitch || durationDivisions === null) throw invalidCzerny50Response();
      const rawBeams = asRecordArray(event.beams);
      const beams = rawBeams.map((beam) => ({
        number: finiteNumber(beam.number),
        value: beam.value,
      })).filter((beam): beam is Czerny50Beam => (
        (beam.number === 1 || beam.number === 2)
        && typeof beam.value === 'string'
        && ['begin', 'continue', 'end', 'forward hook', 'backward hook'].includes(beam.value)
      ));
      if (beams.length !== rawBeams.length) throw invalidCzerny50Response();
      return {
        pitch,
        durationTicks: durationDivisions,
        staff: finiteNumber(event.staff) ?? 1,
        voice: typeof event.voice === 'string' ? event.voice : '1',
        chord: Boolean(event.chord),
        beams,
      };
    });
}

function canonicalGeneratedBarlines(part: ExtractedMeasurePart): Array<{
  location: string;
  style: string;
}> {
  return part.events
    .filter((event) => event.kind === 'barline')
    .map((event) => ({
      location: typeof event.location === 'string' ? event.location : '',
      style: typeof event.style === 'string' ? event.style : '',
    }));
}

export function validateCzerny50ExerciseMusicXml(
  xml: string,
  passage: Czerny50Passage,
  methodId: Czerny50MethodId,
): void {
  try {
    if (
      Buffer.byteLength(xml, 'utf8') > MAX_EXERCISE_XML_BYTES
      || /<!DOCTYPE\b|<!ENTITY\b/i.test(xml)
      || (xml.match(/<measure\b/g) ?? []).length !== RULES.notation.measureCountPerExercise
    ) {
      throw invalidCzerny50Response();
    }
    const method = getCzerny50Method(methodId);
    const generatedParts = [0, 1].map((measureIndex) => generatedMeasurePart(xml, measureIndex));
    [method.firstMeasureDurations, method.secondMeasureDurations].forEach((durations, measureIndex) => {
      const actual = canonicalGeneratedNotes(generatedParts[measureIndex]);
      if (actual.length !== RULES.scope.passageNoteCount) throw invalidCzerny50Response();
      actual.forEach((note, noteIndex) => {
        const expectedDuration = DURATION_DEFINITIONS[durations[noteIndex]].ticks;
        if (
          JSON.stringify(note.pitch) !== JSON.stringify(passage.pitches[noteIndex])
          || note.durationTicks !== expectedDuration
          || note.staff !== 1
          || note.voice !== '1'
          || note.chord
          || JSON.stringify(note.beams) !== JSON.stringify(noteBeams(durations, noteIndex, method.meter))
        ) {
          throw invalidCzerny50Response();
        }
      });
    });

    if (
      JSON.stringify(canonicalGeneratedBarlines(generatedParts[0])) !== JSON.stringify([
        { location: 'left', style: 'heavy-light' },
        { location: 'right', style: 'regular' },
      ])
      || JSON.stringify(canonicalGeneratedBarlines(generatedParts[1])) !== JSON.stringify([
        { location: 'right', style: 'light-heavy' },
      ])
    ) {
      throw invalidCzerny50Response();
    }

    const firstMeasure = generatedParts[0];
    const attributes = firstMeasure.events.find((event) => event.kind === 'attributes');
    const time = asRecordArray(attributes?.times)[0];
    if (
      !time
      || JSON.stringify(time.beats) !== JSON.stringify([String(method.meter.beats)])
      || JSON.stringify(time.beatTypes) !== JSON.stringify([String(method.meter.beatType)])
    ) {
      throw invalidCzerny50Response();
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'OPENAI_INVALID_RESPONSE') throw error;
    throw new AppError(
      502,
      'OPENAI_INVALID_RESPONSE',
      'The generated Czerny Etude No. 50 MusicXML did not pass validation.',
      { cause: error },
    );
  }
}

export function generateCzerny50PracticeExercise(
  methodId: Czerny50MethodId,
  passage: Czerny50Passage,
  sourceMeasure: ExtractedMeasure,
): GeneratedPracticeExercise {
  const method = getCzerny50Method(methodId);
  const title = exerciseTitle(method, passage);
  const measures = [method.firstMeasureDurations, method.secondMeasureDurations].map(
    (durations, measureIndex) => [
      `<measure number="${measureIndex + 1}">`,
      measureIndex === 0
        ? [
            '<attributes>',
            `<divisions>${DIVISIONS}</divisions>`,
            sourceKeyXml(sourceMeasure, passage),
            `<time><beats>${method.meter.beats}</beats><beat-type>${method.meter.beatType}</beat-type></time>`,
            sourceClefXml(sourceMeasure, passage),
            '</attributes>',
            '<barline location="left"><bar-style>heavy-light</bar-style></barline>',
            directionXml(method),
          ].join('')
        : '',
      passage.pitches.map((pitch, pitchIndex) => noteXml(
        pitch,
        durations[pitchIndex],
        noteBeams(durations, pitchIndex, method.meter),
      )).join(''),
      measureIndex === 0
        ? '<barline location="right"><bar-style>regular</bar-style></barline>'
        : '<barline location="right"><bar-style>light-heavy</bar-style></barline>',
      '</measure>',
    ].join(''),
  );
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<score-partwise version="4.0">',
    `<work><work-title>${escapeXml(title)}</work-title></work>`,
    '<part-list><score-part id="P1"><part-name>Practice Exercise</part-name></score-part></part-list>',
    '<part id="P1">',
    ...measures,
    '</part>',
    '</score-partwise>',
  ].join('');
  validateCzerny50ExerciseMusicXml(xml, passage, methodId);
  return {
    title,
    explanationSentences: [...method.instructionSentences],
    musicXml: xml,
  };
}

export function materializeCzerny50PracticeAnalysis(
  plan: AICzerny50Analysis,
  sourceMeasure: ExtractedMeasure,
  context: Czerny50PracticeContext,
): GeneratedMeasureAnalysis {
  const parsed = AICzerny50AnalysisSchema.safeParse(plan);
  if (!parsed.success || context.scoreFilename !== CZERNY50_SCORE_FILENAME) {
    throw invalidCzerny50Response();
  }
  const analysis = validateAnalysisText(parsed.data.analysis);
  const passage = context.passages.find((candidate) => candidate.id === parsed.data.passageId);
  const [firstMethodId, secondMethodId] = parsed.data.methodIds;
  if (!passage || firstMethodId === secondMethodId) throw invalidCzerny50Response();

  const first = generateCzerny50PracticeExercise(firstMethodId, passage, sourceMeasure);
  const second = generateCzerny50PracticeExercise(secondMethodId, passage, sourceMeasure);
  if (first.title === second.title || first.musicXml === second.musicXml) throw invalidCzerny50Response();
  return {
    analysis,
    exercises: [first, second],
  };
}
