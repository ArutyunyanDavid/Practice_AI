import { describe, expect, it } from 'vitest';
import { musicalContent, similarExercises } from '../server/exercise-similarity.js';
import { assertFreshExercises, rememberExercise } from '../server/exercise-history.js';

type Event = { step: string; duration?: number; accent?: string; rest?: number; chord?: string };

function score(events: Event[], title = 'Practice', staff = 1) {
  return `<score-partwise version="4.0"><work><work-title>${title}</work-title></work>
    <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1"><measure number="1"><attributes><divisions>4</divisions></attributes>
    ${events.map((event) => `<note><pitch><step>${event.step}</step><octave>5</octave></pitch>
      <duration>${event.duration ?? 4}</duration><staff>${staff}</staff>
      ${event.accent ? `<notations><articulations><${event.accent}/></articulations></notations>` : ''}</note>
      ${event.chord ? `<note><chord/><pitch><step>${event.chord}</step><octave>5</octave></pitch><duration>${event.duration ?? 4}</duration><staff>${staff}</staff></note>` : ''}
      ${event.rest ? `<note><rest/><duration>${event.rest}</duration><staff>${staff}</staff></note>` : ''}`).join('')}
    </measure></part></score-partwise>`;
}

const line: Event[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'].map((step) => ({ step }));
const signature = (events: Event[], methodId = 'method-one', staff = 1) => ({ methodId, musicalContent: musicalContent(score(events, 'Practice', staff)) });

describe('musical exercise comparison', () => {
  it('ignores titles, formatting, and method labels for identical music', () => {
    const exercise = { title: 'First', explanationSentences: ['Practice the notes slowly.', 'Keep your hand feeling relaxed.'] as [string, string], musicXml: score(line) };
    const renamed = { ...exercise, title: 'Second', musicXml: score(line, 'Another title').replaceAll('<note>', '\n<note>') };
    expect(() => assertFreshExercises([rememberExercise(renamed, 'different-method')], [rememberExercise(exercise, 'original-method')])).toThrow(/too similar/);
  });

  it('rejects uniform slowing and extra repetitions of the same pattern', () => {
    expect(similarExercises(signature(line), signature(line.map((event) => ({ ...event, duration: 8 }))))).toBe(true);
    expect(similarExercises(signature(line), signature([...line, ...line]))).toBe(true);
  });

  it('rejects a tiny pitch edit even with a different method label', () => {
    const changed = structuredClone(line);
    changed[3].step = 'E';
    expect(similarExercises(signature(line), signature(changed, 'another-method'))).toBe(true);
  });

  it('rejects the same accent placement with other pitches or stronger accent symbols', () => {
    const first = line.map((event, index) => ({ ...event, accent: index % 2 === 0 ? 'accent' : undefined }));
    const changed = first.map((event) => ({ ...event, step: 'G', accent: event.accent ? 'strong-accent' : undefined }));
    expect(similarExercises(signature(first), signature(changed, 'another-method'))).toBe(true);
  });

  it('accepts moving accents to other notes within the same method', () => {
    const first = line.map((event, index) => ({ ...event, accent: index % 2 === 0 ? 'accent' : undefined }));
    const shifted = line.map((event, index) => ({ ...event, accent: index % 2 === 1 ? 'accent' : undefined }));
    expect(similarExercises(signature(first), signature(shifted))).toBe(false);
  });

  it('accepts genuinely different rhythms, rest groupings, and staff isolation', () => {
    const dotted = line.map((event, index) => ({ ...event, duration: index % 2 === 0 ? 6 : 2 }));
    const groups = line.map((event, index) => ({ ...event, rest: index % 2 === 1 ? 4 : undefined }));
    expect(similarExercises(signature(line), signature(dotted))).toBe(false);
    expect(similarExercises(signature(line), signature(groups))).toBe(false);
    expect(similarExercises(signature(line), signature(line, 'other-hand', 2))).toBe(false);
  });

  it('compares simultaneous chords independently of XML note ordering', () => {
    const chords = line.map((event) => ({ ...event, chord: 'G' }));
    const reordered = chords.map((event) => ({ step: event.chord, chord: event.step }));
    expect(similarExercises(signature(chords), signature(reordered))).toBe(true);
  });

  it('checks the entire retained history, including its oldest exercise', () => {
    const saved = (index: number) => rememberExercise({ title: `Pattern ${index}`, explanationSentences: ['Practice this pattern slowly.', 'Keep your hand feeling relaxed.'], musicXml: score(line.map((event, n) => ({ ...event, rest: n === 2 ? index : undefined }))) }, `method-${index}`);
    const used = Array.from({ length: 20 }, (_, index) => saved(index + 1));
    expect(() => assertFreshExercises([saved(1)], used)).toThrow(/too similar/);
  });
});
