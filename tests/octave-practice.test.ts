import { describe, expect, it } from 'vitest';
import { extractMeasureForAnalysis } from '../server/measure.js';
import {
  detectOctavePassage,
  generateOctavePracticeExercises,
  getOctavePracticeRules,
  getOctaveRulesFileReadCount,
} from '../server/octave-practice.js';
import { assertMusicXml } from '../server/xml.js';

interface PitchSpec {
  step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  alter?: number;
  octave: number;
}

interface AttackSpec {
  lower: PitchSpec;
  voice?: string;
  upper?: PitchSpec;
  upperVoice?: string;
  inner?: PitchSpec;
}

function pitchXml(pitch: PitchSpec): string {
  return [
    '<pitch>',
    `<step>${pitch.step}</step>`,
    pitch.alter ? `<alter>${pitch.alter}</alter>` : '',
    `<octave>${pitch.octave}</octave>`,
    '</pitch>',
  ].join('');
}

function noteXml(
  pitch: PitchSpec,
  staff: 1 | 2,
  voice: string,
  chord: boolean,
): string {
  return [
    '<note>',
    chord ? '<chord/>' : '',
    pitchXml(pitch),
    '<duration>4</duration>',
    `<voice>${voice}</voice><type>eighth</type><staff>${staff}</staff>`,
    '</note>',
  ].join('');
}

function attackXml(attack: AttackSpec, staff: 1 | 2): string {
  const voice = attack.voice ?? '1';
  const upper = attack.upper ?? { ...attack.lower, octave: attack.lower.octave + 1 };
  return [
    noteXml(attack.lower, staff, voice, false),
    attack.inner ? noteXml(attack.inner, staff, voice, true) : '',
    noteXml(upper, staff, attack.upperVoice ?? voice, true),
  ].join('');
}

function octaveScore(right: AttackSpec[], left: AttackSpec[] = []): string {
  const rightXml = right.map((attack) => attackXml(attack, 1)).join('');
  const leftXml = left.map((attack) => attackXml(attack, 2)).join('');
  const backup = right.length > 0 && left.length > 0
    ? `<backup><duration>${right.length * 4}</duration></backup>`
    : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<score-partwise version="4.0">',
    '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>',
    '<part id="P1"><measure number="1">',
    '<attributes><divisions>8</divisions><staves>2</staves>',
    '<key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>',
    '<clef number="1"><sign>G</sign><line>2</line></clef>',
    '<clef number="2"><sign>F</sign><line>4</line></clef></attributes>',
    rightXml,
    backup,
    leftXml,
    '</measure></part></score-partwise>',
  ].join('');
}

function pitches(steps: Array<PitchSpec['step']>, octave: number): AttackSpec[] {
  return steps.map((step) => ({ lower: { step, octave } }));
}

function noteEvents(xml: string, measureIndex = 0) {
  return extractMeasureForAnalysis(xml, measureIndex).parts[0].events
    .filter((event) => event.kind === 'note');
}

function eventPitch(event: Record<string, unknown>): Record<string, unknown> | null {
  return event.pitch && typeof event.pitch === 'object'
    ? event.pitch as Record<string, unknown>
    : null;
}

function eventFingering(event: Record<string, unknown>): string | null {
  const technical = Array.isArray(event.technical) ? event.technical : [];
  const mark = technical.find((candidate) => (
    candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).name === 'fingering'
  ));
  const value = mark && typeof mark === 'object' ? (mark as Record<string, unknown>).value : null;
  return typeof value === 'string' ? value : null;
}

describe('extracted octave practice rules', () => {
  it('loads and validates the JSON singleton once without reading the DOCX per request', () => {
    const first = getOctavePracticeRules();
    const second = getOctavePracticeRules();
    expect(first).toBe(second);
    expect(first.schemaVersion).toBe(2);
    expect(getOctaveRulesFileReadCount()).toBe(1);
    expect(first.source).toMatchObject({
      document: 'Octave_Practice_Guide.docx',
      treatAsTeachingReferenceOnly: true,
      loadDocumentAtRuntime: false,
    });
    expect(first.methods.map((method) => method.id)).toEqual([
      'separate-finger-lines',
      'dotted-rhythm-variations',
      'secure-landings',
      'release-and-reset',
      'short-groups',
    ]);
    expect(first.selection).toMatchObject({
      firstExercise: 'separate-finger-lines',
      secondExerciseByPattern: {
        runs: 'dotted-rhythm-variations',
        jumps: 'secure-landings',
        repeated: 'release-and-reset',
        'long-mixed': 'short-groups',
      },
    });
    expect(first.implementationDefaults.paths).toContain('selection.mixedPassagePriority');
    for (const method of first.methods) {
      expect(method.sentenceTemplates).toHaveLength(2);
      expect(method.sentenceTemplates[1]).toContain(
        'original measure with its real rhythm, articulation, and musical character.',
      );
    }
  });
});

describe('octave passage detection and generation', () => {
  it('detects a right-hand run and engraves finger lines plus both dotted-rhythm variations', () => {
    const measure = extractMeasureForAnalysis(octaveScore(pitches(['C', 'D', 'E', 'F'], 5)), 0);
    const context = detectOctavePassage(measure);
    expect(context).toMatchObject({
      pattern: 'runs',
      affectedHands: ['right'],
      selectedMethods: ['separate-finger-lines', 'dotted-rhythm-variations'],
    });
    const exercises = generateOctavePracticeExercises(measure, context!);
    expect(exercises).toHaveLength(2);
    expect(exercises[0].title).toBe('Right Hand Separate Finger Lines');
    expect(exercises[1].title).toBe('Right Hand Dotted Octave Rhythms');

    const fifthLine = noteEvents(exercises[0].musicXml, 0);
    const thumbLine = noteEvents(exercises[0].musicXml, 1);
    expect(fifthLine.map((event) => eventPitch(event)?.octave)).toEqual([6, 6, 6, 6]);
    expect(fifthLine.map(eventFingering)).toEqual(['5', '5', '5', '5']);
    expect(thumbLine.map((event) => eventPitch(event)?.octave)).toEqual([5, 5, 5, 5]);
    expect(thumbLine.map(eventFingering)).toEqual(['1', '1', '1', '1']);

    const longShort = noteEvents(exercises[1].musicXml, 0).filter((event) => !event.chord);
    const shortLong = noteEvents(exercises[1].musicXml, 1).filter((event) => !event.chord);
    expect(longShort.map((event) => event.durationQuarterNotes)).toEqual([0.75, 0.25, 0.75, 0.25]);
    expect(shortLong.map((event) => event.durationQuarterNotes)).toEqual([0.25, 0.75, 0.25, 0.75]);
    for (const exercise of exercises) {
      expect(exercise.explanationSentences).toHaveLength(2);
      expect(exercise.musicXml).not.toMatch(/<!DOCTYPE|<!ENTITY/i);
      expect(assertMusicXml(exercise.musicXml)['score-partwise']).toBeTruthy();
    }
  });

  it('maps left-hand finger five to the lower pitch and chooses release/reset for repetitions', () => {
    const repeated = Array.from({ length: 4 }, () => ({ lower: { step: 'A' as const, octave: 2 } }));
    const measure = extractMeasureForAnalysis(octaveScore([], repeated), 0);
    const context = detectOctavePassage(measure);
    expect(context).toMatchObject({
      pattern: 'repeated',
      affectedHands: ['left'],
      selectedMethods: ['separate-finger-lines', 'release-and-reset'],
    });
    const exercises = generateOctavePracticeExercises(measure, context!);
    const fifthLine = noteEvents(exercises[0].musicXml, 0);
    const thumbLine = noteEvents(exercises[0].musicXml, 1);
    expect(fifthLine.map((event) => eventPitch(event)?.octave)).toEqual([2, 2, 2, 2]);
    expect(fifthLine.map(eventFingering)).toEqual(['5', '5', '5', '5']);
    expect(thumbLine.map((event) => eventPitch(event)?.octave)).toEqual([3, 3, 3, 3]);
    expect(thumbLine.map(eventFingering)).toEqual(['1', '1', '1', '1']);
    expect(exercises[1].title).toBe('Left Hand Release and Reset');
    const releaseNotes = noteEvents(exercises[1].musicXml);
    expect(releaseNotes.filter((event) => event.rest)).toHaveLength(4);
    expect(releaseNotes.filter((event) => event.articulations)).toHaveLength(4);
  });

  it('chooses landing drills for octave jumps and preserves complete source octave pairs', () => {
    const measure = extractMeasureForAnalysis(octaveScore(pitches(['C', 'G', 'C'], 4)), 0);
    const context = detectOctavePassage(measure);
    expect(context?.pattern).toBe('jumps');
    const exercises = generateOctavePracticeExercises(measure, context!);
    expect(exercises[1].title).toBe('Right Hand Secure Octave Landings');
    const events = noteEvents(exercises[1].musicXml);
    expect(events.filter((event) => event.rest)).toHaveLength(3);
    expect(events.filter((event) => event.pitch)).toHaveLength(6);
    expect(events.filter((event) => event.pitch).map((event) => eventPitch(event)?.step)).toEqual([
      'C', 'C', 'G', 'G', 'C', 'C',
    ]);
  });

  it('detects both hands independently and retains their aligned timing in both exercises', () => {
    const measure = extractMeasureForAnalysis(octaveScore(
      pitches(['C', 'D', 'E'], 5),
      pitches(['C', 'D', 'E'], 2),
    ), 0);
    const context = detectOctavePassage(measure);
    expect(context).toMatchObject({ pattern: 'runs', affectedHands: ['right', 'left'] });
    const exercises = generateOctavePracticeExercises(measure, context!);
    expect(exercises[0].title).toBe('Both Hands Separate Finger Lines');
    for (const exercise of exercises) {
      const firstMeasure = extractMeasureForAnalysis(exercise.musicXml, 0).parts[0];
      expect(firstMeasure.startingContext.staves ?? (
        firstMeasure.events.find((event) => event.kind === 'attributes')?.staves
      )).toBe(2);
      const staffOneOnsets = firstMeasure.events
        .filter((event) => event.kind === 'note' && event.staff === 1 && !event.chord)
        .map((event) => event.onsetQuarterNotes);
      const staffTwoOnsets = firstMeasure.events
        .filter((event) => event.kind === 'note' && event.staff === 2 && !event.chord)
        .map((event) => event.onsetQuarterNotes);
      expect(staffTwoOnsets).toEqual(staffOneOnsets);
    }
  });

  it('uses short groups for a long mixed passage', () => {
    const attacks = pitches(['C', 'D', 'D', 'A', 'B', 'B', 'C'], 4);
    const measure = extractMeasureForAnalysis(octaveScore(attacks), 0);
    const context = detectOctavePassage(measure);
    expect(context).toMatchObject({
      pattern: 'long-mixed',
      selectedMethods: ['separate-finger-lines', 'short-groups'],
    });
    const exercises = generateOctavePracticeExercises(measure, context!);
    expect(exercises[1].title).toBe('Right Hand Short Octave Groups');
    expect(noteEvents(exercises[1].musicXml).filter((event) => event.rest).length).toBeGreaterThanOrEqual(2);
    const connected = noteEvents(exercises[1].musicXml, 1);
    expect(connected.filter((event) => event.rest)).toHaveLength(0);
    expect(connected.filter((event) => event.pitch && !event.chord)).toHaveLength(attacks.length);
  });

  it('preserves every octave attack in passages longer than twelve notes', () => {
    const scale = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
    const attacks: AttackSpec[] = Array.from({ length: 14 }, (_value, index) => ({
      lower: {
        step: scale[index % scale.length],
        octave: 4 + Math.floor(index / scale.length),
      },
    }));
    const measure = extractMeasureForAnalysis(octaveScore(attacks), 0);
    const context = detectOctavePassage(measure);
    expect(context?.pattern).toBe('runs');
    expect(context?.sequences[0].attacks).toHaveLength(attacks.length);

    const exercises = generateOctavePracticeExercises(measure, context!);
    expect(noteEvents(exercises[0].musicXml, 0)).toHaveLength(attacks.length);
    expect(noteEvents(exercises[0].musicXml, 1)).toHaveLength(attacks.length);
    expect(noteEvents(exercises[1].musicXml, 0).filter((event) => event.pitch)).toHaveLength(attacks.length * 2);
    expect(noteEvents(exercises[1].musicXml, 1).filter((event) => event.pitch)).toHaveLength(attacks.length * 2);
  });

  it('keeps isolated, non-octave, cross-voice, and enharmonically spelled intervals on the generic path', () => {
    const isolated = extractMeasureForAnalysis(octaveScore(pitches(['C'], 5)), 0);
    expect(detectOctavePassage(isolated)).toBeNull();

    const nonOctaveXml = octaveScore([
      { lower: { step: 'C', octave: 5 }, upper: { step: 'B', octave: 5 } },
      { lower: { step: 'D', octave: 5 }, upper: { step: 'C', octave: 6 } },
      { lower: { step: 'E', octave: 5 }, upper: { step: 'D', octave: 6 } },
    ]);
    expect(detectOctavePassage(extractMeasureForAnalysis(nonOctaveXml, 0))).toBeNull();

    const crossVoiceXml = octaveScore([
      { lower: { step: 'C', octave: 5 }, upperVoice: '2' },
      { lower: { step: 'D', octave: 5 }, upperVoice: '2' },
      { lower: { step: 'E', octave: 5 }, upperVoice: '2' },
    ]);
    expect(detectOctavePassage(extractMeasureForAnalysis(crossVoiceXml, 0))).toBeNull();

    const enharmonicXml = octaveScore([
      { lower: { step: 'C', octave: 5 }, upper: { step: 'B', alter: 1, octave: 5 } },
      { lower: { step: 'D', octave: 5 }, upper: { step: 'C', alter: 2, octave: 6 } },
      { lower: { step: 'E', octave: 5 }, upper: { step: 'F', alter: -1, octave: 6 } },
    ]);
    expect(detectOctavePassage(extractMeasureForAnalysis(enharmonicXml, 0))).toBeNull();

    const tiedContinuations = octaveScore(pitches(['C', 'D', 'E'], 5))
      .replaceAll('<duration>4</duration>', '<duration>4</duration><tie type="stop"/>');
    expect(detectOctavePassage(extractMeasureForAnalysis(tiedContinuations, 0))).toBeNull();
  });

  it('accepts an octave surrounding an inner chord tone while extracting only the outer finger pair', () => {
    const measure = extractMeasureForAnalysis(octaveScore([
      { lower: { step: 'C', octave: 5 }, inner: { step: 'G', octave: 5 } },
      { lower: { step: 'D', octave: 5 }, inner: { step: 'A', octave: 5 } },
      { lower: { step: 'E', octave: 5 }, inner: { step: 'B', octave: 5 } },
    ]), 0);
    const context = detectOctavePassage(measure);
    expect(context?.pattern).toBe('runs');
    const exercises = generateOctavePracticeExercises(measure, context!);
    expect(noteEvents(exercises[0].musicXml, 0)).toHaveLength(3);
    expect(noteEvents(exercises[1].musicXml, 0).filter((event) => event.pitch)).toHaveLength(6);
  });
});
