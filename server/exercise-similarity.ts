import { createHash } from 'node:crypto';
import { extractMeasureForAnalysis } from './measure.js';

interface MusicalEvent {
  pitches: number[];
  duration: number;
  gap: number;
  articulation: string[];
}

interface MusicalVoice {
  staff: string;
  start: number;
  events: MusicalEvent[];
}

export interface MusicalContent {
  voices: MusicalVoice[];
  fingerprint: string;
  approachFingerprint: string;
  hasAccents: boolean;
}

const pitchSteps: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const rounded = (value: number) => Math.round(value * 10_000) / 10_000;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function marks(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

/** Repeating an existing loop more times is not a new practice approach. */
function shortestLoop<T>(events: T[]): T[] {
  const tokens = events.map((event) => JSON.stringify(event));
  for (let size = 1; size <= tokens.length / 2; size += 1) {
    if (tokens.length % size === 0 && tokens.every((token, index) => token === tokens[index % size])) {
      return events.slice(0, size);
    }
  }
  return events;
}

/** Ignore engraving, labels, chord ordering, enharmonic spelling, and uniform tempo changes. */
export function musicalContent(musicXml: string): MusicalContent {
  type TimedEvent = Omit<MusicalEvent, 'gap'> & { onset: number };
  const voices = new Map<string, { staff: string; events: TimedEvent[] }>();
  const measureCount = (musicXml.match(/<measure\b/g) ?? []).length;
  let measureOffset = 0;
  for (let index = 0; index < measureCount; index += 1) {
    const measure = extractMeasureForAnalysis(musicXml, index);
    measure.parts.forEach((part, partIndex) => {
      for (const note of part.events) {
        if (note.kind !== 'note' || !note.pitch || typeof note.pitch !== 'object') continue;
        const pitch = note.pitch as Record<string, unknown>;
        const midi = (Number(pitch.octave) + 1) * 12 + pitchSteps[String(pitch.step)] + Number(pitch.alter ?? 0);
        const staff = `${partIndex}:${note.staff ?? 1}`;
        const key = `${staff}:${note.voice ?? '1'}`;
        const voice = voices.get(key) ?? { staff, events: [] };
        const onset = rounded(measureOffset + Number(note.onsetQuarterNotes ?? 0));
        const duration = Number(note.durationQuarterNotes ?? 0);
        const articulation = marks(note.articulations).map((mark) => {
          if (mark.name === 'accent' || mark.name === 'marcato' || mark.name === 'strong-accent') return 'accent';
          if (mark.name === 'staccato' || mark.name === 'staccatissimo') return 'detached';
          return String(mark.name);
        });
        const chord = note.chord ? voice.events.find((event) => event.onset === onset && event.duration === duration) : undefined;
        if (chord) {
          chord.pitches.push(midi);
          chord.articulation.push(...articulation);
        } else {
          voice.events.push({ onset, duration, pitches: [midi], articulation });
        }
        voices.set(key, voice);
      }
    });
    measureOffset += Math.max(0, ...measure.parts.map((part) => part.durationQuarterNotes));
  }
  const ordered = [...voices.values()].map((voice) => ({ ...voice, events: voice.events.sort((a, b) => a.onset - b.onset) }));
  // Include rests between attacks as gaps, but ignore leading/trailing padding.
  const durations = ordered.flatMap((voice) => voice.events.flatMap((event, index) => [
    event.duration,
    index + 1 < voice.events.length ? voice.events[index + 1].onset - event.onset - event.duration : 0,
  ])).filter((duration) => duration > 0);
  const unit = Math.min(...durations);
  const start = Math.min(...ordered.flatMap((voice) => voice.events.map((event) => event.onset)));
  const normalized = ordered.map((voice): MusicalVoice => ({
    staff: voice.staff,
    start: rounded((voice.events[0].onset - start) / unit),
    events: voice.events.map((event, index) => ({
      pitches: event.pitches.sort((a, b) => a - b),
      duration: rounded(event.duration / unit),
      gap: index + 1 < voice.events.length ? rounded((voice.events[index + 1].onset - event.onset - event.duration) / unit) : 0,
      articulation: [...new Set(event.articulation)].sort(),
    })),
  })).sort((a, b) => a.staff.localeCompare(b.staff) || a.start - b.start || JSON.stringify(a.events).localeCompare(JSON.stringify(b.events)));
  const content = normalized.map((voice) => ({ ...voice, events: shortestLoop(voice.events) }));
  const approach = normalized.map((voice) => ({
    ...voice,
    events: shortestLoop(voice.events.map(({ pitches, ...event }) => ({ ...event, chordSize: pitches.length }))),
  }));
  return {
    voices: content,
    fingerprint: digest(content),
    approachFingerprint: digest(approach),
    hasAccents: content.some((voice) => voice.events.some((event) => event.articulation.includes('accent'))),
  };
}

/** Bounded edit distance catches tiny note edits, additions, and omissions. */
function nearlyEqual(first: string[], second: string[]): boolean {
  const budget = Math.floor(Math.max(first.length, second.length) * 0.15);
  if (Math.abs(first.length - second.length) > budget) return false;
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row += 1) {
    const current = new Array<number>(second.length + 1).fill(budget + 1);
    current[0] = row;
    for (let column = Math.max(1, row - budget); column <= Math.min(second.length, row + budget); column += 1) {
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[second.length] <= budget;
}

export function similarExercises(
  first: { methodId: string; musicalContent: MusicalContent },
  second: { methodId: string; musicalContent: MusicalContent },
): boolean {
  const a = first.musicalContent;
  const b = second.musicalContent;
  if (a.fingerprint === b.fingerprint) return true;
  if (a.approachFingerprint !== b.approachFingerprint) return false;
  // Reusing an accent pattern or changing pitches within the same method is not a new approach.
  if (first.methodId === second.methodId || (a.hasAccents && b.hasAccents)) return true;
  return a.voices.length === b.voices.length && a.voices.every((voice, index) => (
    nearlyEqual(voice.events.map((event) => JSON.stringify(event)), b.voices[index].events.map((event) => JSON.stringify(event)))
  ));
}
