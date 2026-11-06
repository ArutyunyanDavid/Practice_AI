import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AppError } from './errors.js';
import { deepFreeze } from './practice-rule-utils.js';
import { AIAnalysisTextSchema } from './exercise-musicxml.js';
import type { GeneratedPracticeExercise } from './exercise-musicxml.js';
import { extractMeasureForAnalysis } from './measure.js';
import type { ExtractedMeasure } from './measure.js';
import { assertMusicXml, escapeXml } from './xml.js';

const Articulation = z.object({
  type: z.enum(['none', 'accent', 'staccato', 'tenuto']),
  finger: z.number().int().min(1).max(5).optional(),
  positionInEachTriplet: z.number().int().min(1).max(3).optional(),
});
const Method = z.object({
  id: z.string(),
  exerciseNumber: z.number().int().min(1).max(6),
  title: z.string(),
  measureCount: z.number().int().min(2).max(3),
  movingVoice: z.object({
    noteType: z.literal('eighth'),
    notesPerMeasure: z.number(),
    triplets: z.object({ actualNotes: z.literal(3), normalNotes: z.literal(2) }).passthrough().optional(),
    measures: z.array(z.object({
      measure: z.number(),
      fingerPattern: z.array(z.number().int().min(1).max(5)).optional(),
      articulation: Articulation.optional(),
      directionAboveStaff: z.string().optional(),
    }).passthrough()),
  }).passthrough(),
  sustainedVoice: z.object({
    finger: z.number().int().min(1).max(5),
    repeatAttacks: z.literal(false),
    useTies: z.literal(true),
  }).passthrough().nullable(),
  directionAboveExercise: z.string().nullable(),
  sourceInstructions: z.array(z.string()),
}).passthrough();
const RulesSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.literal('czerny-etude-1-practice-rules'),
  scope: z.object({ scoreFilename: z.literal('Czerny_Etude_1.mscz') }).passthrough(),
  globalNotation: z.object({
    timeSignature: z.object({ beats: z.literal(4), beatType: z.literal(4) }),
    displayFingerNumbers: z.literal(true),
  }).passthrough(),
  methods: z.array(Method).length(6),
}).passthrough().superRefine((rules, ctx) => {
  const invalidPatterns = rules.methods.some((method, index) => (
    method.exerciseNumber !== index + 1
    || method.movingVoice.measures.length !== method.measureCount
    || method.movingVoice.notesPerMeasure !== (method.movingVoice.triplets ? 12 : 8)
    || method.movingVoice.measures.some((bar, barIndex) => (
      bar.measure !== barIndex + 1
      || (bar.fingerPattern && (
        bar.fingerPattern.length !== method.movingVoice.notesPerMeasure
        || bar.fingerPattern.includes(method.sustainedVoice?.finger ?? 0)
      ))
    ))
  ));
  if (new Set(rules.methods.map(method => method.id)).size !== 6 || invalidPatterns) {
    ctx.addIssue({ code: 'custom', message: 'Invalid Czerny 1 method patterns or measure counts.' });
  }
});
const rulesFile = new URL('../Practice_Rules/czerny-etude-1-practice-rules.json', import.meta.url);
const RULES = deepFreeze(RulesSchema.parse(JSON.parse(readFileSync(rulesFile, 'utf8'))));
export const getCzerny1PracticeRules = () => RULES;
export const AICzerny1AnalysisSchema = z.object({ analysis: AIAnalysisTextSchema }).strict();
type Pitch = { step: string; alter: number; octave: number };
type SourceNote = { pitch: Pitch; finger?: number; onset: number; duration: number };
export interface Czerny1Passage {
  id: string;
  hand: 'right' | 'left';
  fifths: number;
  mode?: string;
  notes: SourceNote[];
  fingerPitches: Record<number, Pitch>;
  fingeringsDerived: boolean;
}
export interface Czerny1Context { rules: typeof RULES; passages: Czerny1Passage[] }
const steps = 'CDEFGAB';
const semitones = [0, 2, 4, 5, 7, 9, 11];
const records = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
const diatonic = (p: Pitch) => p.octave * 7 + steps.indexOf(p.step);
const midi = (p: Pitch) => (p.octave + 1) * 12 + semitones[steps.indexOf(p.step)] + p.alter;
const samePitch = (a: Pitch, b: Pitch) => a.step === b.step && a.alter === b.alter && a.octave === b.octave;
function pitchAt(index: number, fifths: number): Pitch {
  const step = steps[((index % 7) + 7) % 7];
  const order = fifths > 0 ? 'FCGDAEB' : 'BEADGCF';
  return { step, octave: Math.floor(index / 7), alter: order.slice(0, Math.abs(fifths)).includes(step) ? Math.sign(fifths) : 0 };
}

/** Select one contiguous, monophonic scale passage per hand; never bridge rests or voice gaps. */
export function detectCzerny1Passage(filename: string, measure: ExtractedMeasure): Czerny1Context | null {
  if (filename.toLowerCase() !== RULES.scope.scoreFilename.toLowerCase()) return null;
  const candidates: Czerny1Passage[] = [];
  for (const [partIndex, part] of measure.parts.entries()) {
    const attributes = part.events.filter(e => e.kind === 'attributes');
    const staves = attributes.find(e => e.staves !== undefined)?.staves ?? part.startingContext.staves;
    if (staves !== 2 || (measure.parts.length > 1 && !/piano|pno|keyboard/i.test(part.name))) continue;
    for (const staff of [1, 2]) {
      // A changing key inside the selection requires a more specific source context.
      if (attributes.some(e => Number(e.onsetQuarterNotes) > 0 && e.keys)) continue;
      const keys = [...records(part.startingContext.keys), ...attributes.flatMap(e => records(e.keys))].reverse();
      const key = keys.find(k => k.staff === staff) ?? keys.find(k => k.staff === undefined);
      const fifths = key?.fifths ?? 0;
      if (typeof fifths !== 'number' || !Number.isInteger(fifths) || Math.abs(fifths) > 7 || (Array.isArray(key?.keySteps) && key.keySteps.length)) continue;
      const staffNotes = part.events.filter(e => e.kind === 'note' && Number(e.staff ?? 1) === staff);
      const onsets = new Map<number, number>();
      for (const e of staffNotes) if (e.pitch) onsets.set(Number(e.onsetQuarterNotes), (onsets.get(Number(e.onsetQuarterNotes)) ?? 0) + 1);
      const voices = new Set(staffNotes.map(e => String(e.voice ?? '1')));
      for (const voice of voices) {
        let run: SourceNote[] = [];
        const runs: SourceNote[][] = [];
        const flush = () => {
          if (run.length >= 3 && new Set(run.map(n => diatonic(n.pitch))).size >= 3) runs.push(run);
          run = [];
        };
        for (const e of staffNotes.filter(e => String(e.voice ?? '1') === voice)) {
          const p = e.pitch as Pitch | undefined;
          const onset = Number(e.onsetQuarterNotes), duration = Number(e.durationQuarterNotes);
          if (
            !p || !steps.includes(p.step) || p.step.length !== 1 || !Number.isInteger(p.octave)
            || e.rest || e.grace || e.chord || onsets.get(onset) !== 1
            || !Number.isFinite(onset) || !(duration > 0)
            || records(e.ties).some(t => (t.attributes as Record<string, unknown>)?.type === 'stop')
          ) {
            flush();
            continue;
          }
          const pitch = { step: p.step, alter: p.alter ?? 0, octave: p.octave };
          const last = run.at(-1);
          if (last && (
            Math.abs(last.onset + last.duration - onset) > 0.00001
            || Math.abs(diatonic(last.pitch) - diatonic(pitch)) > 1
            || Math.abs(midi(last.pitch) - midi(pitch)) > 2
          )) flush();
          const fingerText = records(e.technical).find(t => t.name === 'fingering')?.value;
          const finger = /^[1-5]$/.test(String(fingerText)) ? Number(fingerText) : undefined;
          run.push({ pitch, finger, onset, duration });
        }
        flush();
        for (const notes of runs) {
          const hand = staff === 1 ? 'right' : 'left';
          const original = notes.find(n => n.finger !== undefined);
          const offset = original ? (hand === 'right' ? original.finger! - 1 : 5 - original.finger!) : 0;
          const base = original ? diatonic(original.pitch) - offset : Math.min(...notes.map(n => diatonic(n.pitch)));
          const fingerPitches: Record<number, Pitch> = {};
          for (let i = 0; i < 5; i++) {
            const finger = hand === 'right' ? i + 1 : 5 - i;
            const source = notes.find(n => diatonic(n.pitch) === base + i && (n.finger === undefined || n.finger === finger));
            fingerPitches[finger] = source?.pitch ?? pitchAt(base + i, fifths);
          }
          if (Object.values(fingerPitches).some(p => midi(p) < 21 || midi(p) > 108)) continue;
          candidates.push({
            id: `${partIndex}-${staff}-${voice}-${notes[0].onset}`,
            hand,
            fifths,
            ...(typeof key?.mode === 'string' ? { mode: key.mode } : {}),
            fingerPitches,
            fingeringsDerived: notes.some(n => n.finger === undefined),
            notes: notes.map(note => {
              const assigned = Object.entries(fingerPitches).find(([, pitch]) => samePitch(pitch, note.pitch));
              return { ...note, finger: note.finger ?? (assigned ? Number(assigned[0]) : undefined) };
            }),
          });
        }
      }
    }
  }
  const passages = (['right', 'left'] as const).flatMap(hand => candidates.filter(p => p.hand === hand).sort((a, b) => b.notes.length - a.notes.length).slice(0, 1));
  return passages.length ? { rules: RULES, passages } : null;
}

const direction = (text: string) => `<direction placement="above"><direction-type><words>${escapeXml(text)}</words></direction-type><staff>1</staff></direction>`;

function noteXml(
  pitch: Pitch, finger: number, voice: number, duration: number,
  articulation: string | undefined, triplet: boolean, index: number, total: number,
): string {
  const ties = voice === 2 ? [...(index > 0 ? ['stop'] : []), ...(index < total - 1 ? ['start'] : [])] : [];
  const groupSize = triplet ? 3 : 2;
  const beam = index % groupSize === 0 ? 'begin' : index % groupSize === groupSize - 1 ? 'end' : 'continue';
  const tuplet = triplet ? (index % 3 === 0 ? '<tuplet type="start"/>' : index % 3 === 2 ? '<tuplet type="stop"/>' : '') : '';
  return [
    '<note>',
    `<pitch><step>${pitch.step}</step><alter>${pitch.alter}</alter><octave>${pitch.octave}</octave></pitch>`,
    `<duration>${duration}</duration>`,
    ties.map(type => `<tie type="${type}"/>`).join(''),
    `<voice>${voice}</voice><type>eighth</type>`,
    triplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes><normal-type>eighth</normal-type></time-modification>' : '',
    `<stem>${voice === 2 ? 'down' : 'up'}</stem><staff>1</staff><beam number="1">${beam}</beam>`,
    '<notations>',
    ties.map(type => `<tied type="${type}"/>`).join(''),
    tuplet,
    articulation && articulation !== 'none' ? `<articulations><${articulation}/></articulations>` : '',
    `<technical><fingering>${finger}</fingering></technical></notations></note>`,
  ].join('');
}

function originalEightNotes(passage: Czerny1Passage): SourceNote[] {
  return Array.from({ length: 8 }, (_, index) => passage.notes[index % passage.notes.length]);
}

function supportsFourthFinger(passage: Czerny1Passage): boolean {
  const notes = originalEightNotes(passage);
  return notes.every(note => note.finger !== undefined) && notes.some(note => note.finger === 4);
}

export function generateCzerny1Exercise(methodId: string, passage: Czerny1Passage): GeneratedPracticeExercise {
  const method = RULES.methods.find(method => method.id === methodId);
  if (!method) throw new AppError(500, 'CZERNY1_INVALID_METHOD', 'Unknown Czerny No. 1 practice method.');
  if (method.exerciseNumber <= 2 && !supportsFourthFinger(passage)) {
    throw new AppError(422, 'CZERNY1_FINGERING_UNAVAILABLE', 'This passage does not establish the fourth-finger pattern.');
  }
  const handLabel = passage.hand === 'right' ? 'Right' : 'Left';
  const title = `${handLabel} Hand: ${method.title}`;
  // Six divisions represent both ordinary eighths (3) and triplet eighths (2) exactly.
  const measures = method.movingVoice.measures.map((bar, measureIndex) => {
    const moving = bar.fingerPattern
      ? bar.fingerPattern.map(finger => ({ finger, pitch: passage.fingerPitches[finger] }))
      : originalEightNotes(passage).map(note => ({ finger: note.finger!, pitch: note.pitch }));
    const triplet = Boolean(method.movingVoice.triplets);
    const movingXml = moving.map((note, index) => {
      const marked = bar.articulation?.finger === note.finger
        || bar.articulation?.positionInEachTriplet === index % 3 + 1;
      return noteXml(note.pitch, note.finger, 1, triplet ? 2 : 3,
        marked ? bar.articulation!.type : undefined, triplet, index, moving.length);
    }).join('');
    const held = method.sustainedVoice;
    const heldXml = held
      ? '<backup><duration>24</duration></backup>' + Array.from({ length: 8 }, (_, index) => (
          noteXml(passage.fingerPitches[held.finger], held.finger, 2, 3,
            undefined, false, measureIndex * 8 + index, method.measureCount * 8)
        )).join('')
      : '';
    const text = bar.directionAboveStaff ?? (measureIndex === 0 ? method.directionAboveExercise : null);
    return [
      `<measure number="${measureIndex + 1}">`,
      ...(measureIndex === 0 ? [
        '<attributes><divisions>6</divisions>',
        `<key><fifths>${passage.fifths}</fifths>${passage.mode ? `<mode>${escapeXml(passage.mode)}</mode>` : ''}</key>`,
        '<time><beats>4</beats><beat-type>4</beat-type></time>',
        `<clef><sign>${passage.hand === 'right' ? 'G' : 'F'}</sign><line>${passage.hand === 'right' ? 2 : 4}</line></clef></attributes>`,
      ] : []),
      measureIndex === 0 ? '<barline location="left"><bar-style>heavy-light</bar-style></barline>' : '',
      text ? direction(text) : '',
      movingXml,
      heldXml,
      `<barline location="right"><bar-style>${measureIndex === method.measureCount - 1 ? 'light-heavy' : 'regular'}</bar-style></barline></measure>`,
    ].join('');
  });
  const musicXml = [
    '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">',
    `<work><work-title>${escapeXml(title)}</work-title></work>`,
    `<part-list><score-part id="P1"><part-name>${handLabel} Hand Practice</part-name></score-part></part-list>`,
    `<part id="P1">${measures.join('')}</part></score-partwise>`,
  ].join('');
  assertMusicXml(musicXml);
  // Check serialized voice timelines, allowing the extractor's six-decimal triplet rounding.
  for (let index = 0; index < method.measureCount; index++) {
    const part = extractMeasureForAnalysis(musicXml, index).parts[0];
    for (const voice of method.sustainedVoice ? ['1', '2'] : ['1']) {
      const notes = part.events.filter(event => event.kind === 'note' && event.voice === voice);
      const duration = notes.reduce((sum, note) => sum + Number(note.durationQuarterNotes), 0);
      if (Math.abs(duration - 4) > 0.00001 || Math.abs(Number(notes[0]?.onsetQuarterNotes)) > 0.00001) {
        throw new AppError(500, 'CZERNY1_INVALID_NOTATION', 'The exercise voices failed timing validation.');
      }
    }
  }
  return {
    title,
    musicXml,
    explanationSentences: [
      method.sustainedVoice
        ? `This exercise develops independent movement in your ${passage.hand} hand while one finger stays held.`
        : `This exercise develops controlled finger movement in your ${passage.hand} hand.`,
      'Follow the printed finger numbers and markings while keeping your hand relaxed.',
    ],
  };
}

/** Keep exercise four first, and keep each hand in its own notation viewer. */
export function czerny1ExerciseCandidates(context: Czerny1Context): Array<{ methodId: string; exercise: GeneratedPracticeExercise }> {
  const methods = [...RULES.methods].sort((a, b) => (
    a.exerciseNumber === 4 ? -1 : b.exerciseNumber === 4 ? 1 : a.exerciseNumber - b.exerciseNumber
  ));
  return methods.flatMap(method => context.passages.flatMap(passage => {
    if (method.exerciseNumber <= 2 && !supportsFourthFinger(passage)) return [];
    return [{ methodId: `${method.id}:${passage.id}`, exercise: generateCzerny1Exercise(method.id, passage) }];
  }));
}
