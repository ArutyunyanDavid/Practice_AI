import { XMLParser } from 'fast-xml-parser';
import { AppError } from './errors.js';

export const EXERCISE_DIVISIONS = 48;

export interface WrittenRhythm {
  ticks: number;
  type: string;
  dots?: number;
  timeModification?: { actualNotes: number; normalNotes: number; normalType?: string; normalDots?: number };
}

export interface ExerciseMeter {
  ticks: number;
  xml: string;
}

function invalidRhythm(detail: string): never {
  throw new AppError(500, 'EXERCISE_RHYTHM_INVALID', `The exercise rhythm is invalid: ${detail}.`);
}

/** Preserve additive and composite meters as well as ordinary time signatures. */
export function exerciseMeter(time?: Record<string, unknown>, divisions = EXERCISE_DIVISIONS): ExerciseMeter {
  const beats = time?.beats ?? ['4'];
  const beatTypes = time?.beatTypes ?? ['4'];
  if (!Array.isArray(beats) || !Array.isArray(beatTypes) || !beats.length || beats.length !== beatTypes.length) {
    return invalidRhythm('unsupported time signature');
  }
  let ticks = 0;
  const xml = beats.map((beat: unknown, index) => {
    const beatType: unknown = beatTypes[index];
    if (typeof beat !== 'string' || !/^\d+(?:\+\d+)*$/.test(beat)
      || typeof beatType !== 'string' || !/^(1|2|4|8|16|32|64)$/.test(beatType)) {
      return invalidRhythm('unsupported time signature');
    }
    ticks += beat.split('+').reduce((sum, value) => sum + Number(value), 0) * divisions * 4 / Number(beatType);
    return `<beats>${beat}</beats><beat-type>${beatType}</beat-type>`;
  }).join('');
  if (!(ticks > 0) || !Number.isFinite(ticks)) return invalidRhythm('empty time signature');
  return { ticks, xml: `<time>${xml}</time>` };
}

const TYPE_QUARTERS: Record<string, number> = {
  whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25,
  '32nd': 0.125, '64th': 0.0625, '128th': 0.03125,
};

function durationPieces(ticks: number, triplet = false): WrittenRhythm[] {
  const choices = Object.entries(TYPE_QUARTERS).flatMap(([type, quarters]) => [0, 1].map(dots => ({
    ticks: quarters * EXERCISE_DIVISIONS * (dots ? 1.5 : 1) * (triplet ? 2 / 3 : 1),
    type,
    ...(dots ? { dots } : {}),
    ...(triplet ? { timeModification: { actualNotes: 3, normalNotes: 2, normalType: type, normalDots: dots } } : {}),
  }))).filter(value => Number.isInteger(value.ticks)).sort((a, b) => b.ticks - a.ticks);
  const result: WrittenRhythm[] = [];
  while (ticks > 0) {
    const next = choices.find(value => value.ticks <= ticks);
    // A tuplet cut by an unusual meter can leave a single tick (a triplet 128th).
    if (!next) return [...result, ...durationPieces(ticks, true)];
    result.push(next);
    ticks -= next.ticks;
  }
  return result;
}

interface TimedEvent { onsetTicks: number; duration: WrittenRhythm; rest?: boolean }
export interface RhythmFragment<T> {
  source?: T;
  onsetTicks: number;
  duration: WrittenRhythm;
  tieStart: boolean;
  tieStop: boolean;
}

/** Divide one sequential voice into full bars. Chords remain a single event. */
export function partitionExerciseVoice<T extends TimedEvent>(
  events: T[], barTicks: number, barCount: number,
): Array<Array<RhythmFragment<T>>> {
  if (!Number.isInteger(barTicks) || barTicks <= 0 || !Number.isInteger(barCount) || barCount < 1 || barCount > 512) {
    return invalidRhythm('unsupported measure length');
  }
  const bars: Array<Array<RhythmFragment<T>>> = Array.from({ length: barCount }, () => []);
  let cursor = 0;
  const append = (end: number, source?: T) => {
    const start = cursor;
    if (!Number.isInteger(end) || end <= start || end > barTicks * barCount) return invalidRhythm('invalid event duration');
    while (cursor < end) {
      const barIndex = Math.floor(cursor / barTicks);
      const ticks = Math.min(end - cursor, barTicks - cursor % barTicks);
      const pieces = source && source.duration.type && ticks === source.duration.ticks
        ? [source.duration]
        : durationPieces(ticks, source?.duration.timeModification?.actualNotes === 3
          && source.duration.timeModification.normalNotes === 2);
      for (const duration of pieces) {
        bars[barIndex].push({
          source, onsetTicks: cursor % barTicks, duration,
          tieStop: Boolean(source && !source.rest && cursor > start),
          tieStart: Boolean(source && !source.rest && cursor + duration.ticks < end),
        });
        cursor += duration.ticks;
      }
    }
  };
  for (const event of events) {
    if (!Number.isInteger(event.onsetTicks) || event.onsetTicks < cursor) return invalidRhythm('overlapping voice events');
    if (event.onsetTicks > cursor) append(event.onsetTicks);
    append(cursor + event.duration.ticks, event);
  }
  if (cursor < barTicks * barCount) append(barTicks * barCount);
  return bars;
}

type XmlNode = Record<string, unknown>;
const rhythmParser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false });
const children = (nodes: XmlNode[], name: string): XmlNode[] => nodes.filter(node => name in node);
const contents = (node: XmlNode | undefined, name: string): XmlNode[] => Array.isArray(node?.[name]) ? node[name] as XmlNode[] : [];
const value = (nodes: XmlNode[], name: string): string | undefined => {
  const text = contents(nodes.find(node => name in node), name)[0]?.['#text'];
  return typeof text === 'string' ? text : undefined;
};
const attribute = (node: XmlNode, name: string): unknown => (node[':@'] as Record<string, unknown> | undefined)?.[`@_${name}`];

/** Check serialized timing independently of each generator's notation plan. */
export function validateExerciseRhythm(xml: string): void {
  const root = contents((rhythmParser.parse(xml) as XmlNode[]).find(node => node['score-partwise']), 'score-partwise');
  const parts = children(root, 'part');
  if (!parts.length) return invalidRhythm('missing partwise score');
  for (const part of parts) {
    let divisions = 0;
    let capacity = 0;
    const ties = new Map<string, number>();
    let elapsed = 0;
    const measures = children(contents(part, 'part'), 'measure');
    if (!measures.length) return invalidRhythm('missing measures');
    for (const measure of measures) {
      let cursor = 0;
      let previousOnset = 0;
      let previousVoice = '';
      let previousDuration = 0;
      const voiceEnds = new Map<string, number>();
      const check = (ok: boolean, detail: string) => {
        if (!ok) invalidRhythm(`measure ${attribute(measure, 'number') ?? '?'} ${detail}`);
      };
      for (const node of contents(measure, 'measure')) {
        if (node.attributes) {
          const attributes = contents(node, 'attributes');
          divisions = Number(value(attributes, 'divisions') ?? divisions);
          const time = children(attributes, 'time')[0];
          if (time) {
            const beats = children(contents(time, 'time'), 'beats').map(item => value([item], 'beats'));
            const beatTypes = children(contents(time, 'time'), 'beat-type').map(item => value([item], 'beat-type'));
            capacity = exerciseMeter({ beats, beatTypes }, 1).ticks;
          }
        } else if (node.backup || node.forward) {
          const movement = Number(value(contents(node, node.backup ? 'backup' : 'forward'), 'duration')) / divisions;
          check(movement > 0, 'has an invalid cursor movement');
          cursor += node.backup ? -movement : movement;
          check(cursor >= -1e-8 && cursor <= capacity + 1e-8, 'moves outside its time signature');
        } else if (node.note) {
          const note = contents(node, 'note');
          if (children(note, 'grace').length) continue;
          const duration = Number(value(note, 'duration')) / divisions;
          const chord = children(note, 'chord').length > 0;
          const voice = `${value(note, 'staff') ?? '1'}:${value(note, 'voice') ?? '1'}`;
          const onset = chord ? previousOnset : cursor;
          check(duration > 0 && Number.isFinite(duration), 'has an invalid note duration');
          check(onset >= -1e-8 && onset + duration <= capacity + 1e-8, 'exceeds its time signature');
          if (chord) {
            check(previousVoice === voice && Math.abs(previousDuration - duration) < 1e-8, 'has an unaligned chord');
          } else {
            check(Math.abs((voiceEnds.get(voice) ?? 0) - onset) < 1e-8, 'has a gap or overlap in a voice');
            voiceEnds.set(voice, onset + duration);
            previousOnset = onset;
            previousDuration = duration;
            previousVoice = voice;
            cursor += duration;
          }
          const type = value(note, 'type') ?? '';
          const dots = children(note, 'dot').length;
          const modification = contents(children(note, 'time-modification')[0], 'time-modification');
          const ratio = modification.length
            ? Number(value(modification, 'normal-notes')) / Number(value(modification, 'actual-notes')) : 1;
          const written = TYPE_QUARTERS[type] * (2 - 2 ** -dots) * ratio;
          check(Number.isFinite(written) && Math.abs(written - duration) < 1e-8, 'has inconsistent written and sounding durations');
          const pitch = contents(children(note, 'pitch')[0], 'pitch');
          const tieNodes = children(note, 'tie').map(tie => attribute(tie, 'type'));
          const tiedNodes = children(contents(children(note, 'notations')[0], 'notations'), 'tied').map(tie => attribute(tie, 'type'));
          check(JSON.stringify([...tieNodes].sort()) === JSON.stringify([...tiedNodes].sort()), 'has inconsistent tie marks');
          if (pitch.length) {
            const key = `${voice}:${value(pitch, 'step')}:${value(pitch, 'alter') ?? '0'}:${value(pitch, 'octave')}`;
            if (tieNodes.includes('stop')) {
              check(Math.abs((ties.get(key) ?? -1) - (elapsed + onset)) < 1e-8, 'has a broken tie');
              ties.delete(key);
            } else check(!ties.has(key), 'reattacks a tied note');
            if (tieNodes.includes('start')) ties.set(key, elapsed + onset + duration);
          } else check(tieNodes.length === 0, 'ties a rest');
        }
      }
      check(divisions > 0 && capacity > 0 && voiceEnds.size > 0, 'has no rhythmic context');
      for (const end of voiceEnds.values()) check(Math.abs(end - capacity) < 1e-8, 'has an incomplete voice');
      elapsed += capacity;
    }
    if (ties.size) invalidRhythm('unfinished tie at the end of the exercise');
  }
}
