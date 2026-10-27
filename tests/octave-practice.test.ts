import { describe, expect, it } from 'vitest';
import { extractMeasureForAnalysis } from '../server/measure.js';
import {
  AIOctaveAnalysisSchema,
  detectOctavePassage,
  generateOctavePracticeExercises,
} from '../server/octave-practice.js';
import type {
  OctaveMethodId,
  OctavePracticeContext,
} from '../server/octave-practice.js';
import {
  eligibleOctaveMethodIds,
  getOctavePracticeRules,
  getOctaveRulesFileReadCount,
  selectOctaveMethodPair,
} from '../server/octave-rules.js';
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

function octaveScore(
  right: AttackSpec[],
  left: AttackSpec[] = [],
  fifths = 0,
): string {
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
    `<key><fifths>${fifths}</fifths></key>`,
    '<time><beats>4</beats><beat-type>4</beat-type></time>',
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

function eventArticulation(event: Record<string, unknown>): string | null {
  const articulations = Array.isArray(event.articulations) ? event.articulations : [];
  const mark = articulations.find((candidate) => candidate && typeof candidate === 'object');
  const name = mark && typeof mark === 'object' ? (mark as Record<string, unknown>).name : null;
  return typeof name === 'string' ? name : null;
}

function eventBeams(event: Record<string, unknown>): Array<{ number: number; value: string }> {
  const beams = Array.isArray(event.beams) ? event.beams : [];
  return beams.map((beam) => {
    const value = beam && typeof beam === 'object' ? beam as Record<string, unknown> : {};
    return { number: Number(value.number), value: String(value.value) };
  });
}

function measureBarlines(xml: string, measureIndex: number): Array<{
  location: unknown;
  style: unknown;
}> {
  return extractMeasureForAnalysis(xml, measureIndex).parts[0].events
    .filter((event) => event.kind === 'barline')
    .map((event) => ({ location: event.location, style: event.style }));
}

function musicXmlMeasureCount(xml: string): number {
  return (xml.match(/<measure\b/g) ?? []).length;
}

function expectSafeExercises(
  exercises: ReturnType<typeof generateOctavePracticeExercises>,
): void {
  expect(exercises).toHaveLength(2);
  for (const exercise of exercises) {
    expect(exercise.explanationSentences).toHaveLength(2);
    for (const sentence of exercise.explanationSentences) {
      expect(sentence.trim()).toBe(sentence);
      expect(sentence.endsWith('.')).toBe(true);
      expect(sentence.match(/[.!?]/g)).toHaveLength(1);
    }
    expect(exercise.musicXml).not.toMatch(/<!DOCTYPE|<!ENTITY|<script\b|javascript:/i);
    const parsed = assertMusicXml(exercise.musicXml);
    expect(parsed['score-partwise']).toBeTruthy();
    expect(parsed['score-timewise']).toBeUndefined();
    const measureCount = musicXmlMeasureCount(exercise.musicXml);
    for (let measureIndex = 0; measureIndex < measureCount; measureIndex += 1) {
      expect(measureBarlines(exercise.musicXml, measureIndex)).toEqual([
        ...(measureIndex === 0 ? [{ location: 'left', style: 'heavy-light' }] : []),
        {
          location: 'right',
          style: measureIndex === measureCount - 1 ? 'light-heavy' : 'regular',
        },
      ]);
    }
  }
}

function contextWithMethods(
  context: OctavePracticeContext | null,
  first: OctaveMethodId,
  second: OctaveMethodId,
): OctavePracticeContext {
  if (!context) throw new Error('Expected the fixture to contain a supported octave passage.');
  return { ...context, selectedMethods: [first, second] };
}

function expectEligibleDistinctPair(context: OctavePracticeContext): void {
  const attackCount = Math.min(...context.sequences.map((sequence) => sequence.attacks.length));
  const eligible = eligibleOctaveMethodIds(context.pattern, attackCount);
  expect(context.selectedMethods).toHaveLength(2);
  expect(new Set(context.selectedMethods).size).toBe(2);
  expect(eligible).toEqual(expect.arrayContaining(context.selectedMethods));
}

describe('standalone octave practice rules', () => {
  it('uses the concise shared analysis contract', () => {
    expect(AIOctaveAnalysisSchema.safeParse({
      analysis: 'The octaves need even landings. Practice slowly with a relaxed wrist.',
    }).success).toBe(true);
    expect(AIOctaveAnalysisSchema.safeParse({
      analysis: 'The octaves need even landings.',
    }).success).toBe(false);
  });

  it('loads the versioned JSON singleton once with the new source and all six methods', () => {
    const first = getOctavePracticeRules();
    const second = getOctavePracticeRules();
    const methodIds = first.methods.map((method) => method.id);

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.schemaVersion).toBe(5);
    expect(first.id).toBe('czerny-etude-49-practice-rules');
    expect(getOctaveRulesFileReadCount()).toBe(1);
    expect(first.source).toEqual({
      document: 'Czerny_etude_49.docx',
      sha256: '7b3e3784a32f085c7f130a099e612b664a6ae5eb61d7f3a4f8be777660fc1e59',
      treatAsTeachingReferenceOnly: true,
      loadDocumentAtRuntime: false,
    });
    expect(methodIds).toEqual([
      'octave-separate-finger-lines',
      'octave-dotted-rhythm-variations',
      'octave-expanding-five-note-pattern',
      'octave-five-note-alternating-accents',
      'octave-progressive-groups-with-rests',
      'octave-repeated-pairs-alternating-accents',
    ]);
    expect(JSON.stringify(first)).not.toMatch(/octave-secure-landings|octave-release-reset/);
    expect(first.detection).toMatchObject({
      maximumScaleLikeStepSemitones: 2,
      progressiveMinimumAttacks: 4,
    });
    expect(first.handRules.outerFingerByKeyColor).toEqual({ white: 5, black: 4 });
    expect(first.globalNotation).toMatchObject({
      separateExerciseSystems: true,
      combineExercises: false,
      defaultNoteType: 'eighth',
      followOriginalKeySignature: true,
    });
    expect(first.methods.every((method) => method.instructions.length === 2)).toBe(true);
    expect(first.selection).toMatchObject({ exerciseCount: 2 });
  });

  it('selects exactly two distinct eligible methods and varies recent pairs', () => {
    const eligible = eligibleOctaveMethodIds('runs', 4);
    expect(eligible).toEqual([
      'octave-separate-finger-lines',
      'octave-dotted-rhythm-variations',
      'octave-expanding-five-note-pattern',
      'octave-five-note-alternating-accents',
      'octave-progressive-groups-with-rests',
      'octave-repeated-pairs-alternating-accents',
    ]);

    const pairs = Array.from({ length: 8 }, () => selectOctaveMethodPair('runs', 4));
    for (const pair of pairs) {
      if (!pair) throw new Error('A four-note run must have eligible octave exercises.');
      expect(pair).toHaveLength(2);
      expect(new Set(pair).size).toBe(2);
      expect(eligible).toEqual(expect.arrayContaining(pair));
    }
    const pairKey = (pair: (typeof pairs)[number]) => {
      if (!pair) throw new Error('A four-note run must have eligible octave exercises.');
      return [...pair].sort().join('|');
    };
    for (let index = 1; index < pairs.length; index += 1) {
      expect(pairKey(pairs[index])).not.toBe(pairKey(pairs[index - 1]));
    }
    expect(new Set(pairs.map(pairKey)).size).toBeGreaterThan(2);
  });

  it('enforces the special eligibility conditions for exercises four and five', () => {
    expect(eligibleOctaveMethodIds('jumps', 8)).not.toContain('octave-five-note-alternating-accents');
    expect(eligibleOctaveMethodIds('runs', 3)).toContain('octave-five-note-alternating-accents');

    for (const pattern of ['runs', 'jumps', 'long-mixed'] as const) {
      expect(eligibleOctaveMethodIds(pattern, 3)).not.toContain('octave-progressive-groups-with-rests');
      expect(eligibleOctaveMethodIds(pattern, 4)).toContain('octave-progressive-groups-with-rests');
    }
  });
});

describe('octave passage detection and generation', () => {
  it('treats a two-position stepwise passage as scale-like for exercise four', () => {
    const measure = extractMeasureForAnalysis(octaveScore(pitches(['C', 'D'], 5)), 0);
    const detected = detectOctavePassage(measure);
    expect(detected).toMatchObject({ pattern: 'runs' });
    expect(detected?.sequences[0].attacks).toHaveLength(2);
    expect(eligibleOctaveMethodIds('runs', 2)).toContain('octave-five-note-alternating-accents');

    const context = contextWithMethods(
      detected,
      'octave-five-note-alternating-accents',
      'octave-separate-finger-lines',
    );
    const exercises = generateOctavePracticeExercises(measure, context);
    expect(musicXmlMeasureCount(exercises[0].musicXml)).toBe(2);
    expect(noteEvents(exercises[0].musicXml, 0)
      .filter((event) => eventPitch(event) && !event.chord)
      .map((event) => eventPitch(event)?.step)).toEqual(['C', 'D', 'E', 'F', 'G', 'F', 'E', 'D']);
    expectSafeExercises(exercises);
  });

  it('engraves the accent and progressive transformations for an eligible four-attack run', () => {
    const measure = extractMeasureForAnalysis(octaveScore([
      { lower: { step: 'C', octave: 5 } },
      { lower: { step: 'D', octave: 5 } },
      { lower: { step: 'E', octave: 5 } },
      { lower: { step: 'F', alter: 1, octave: 5 } },
    ], [], 1), 0);
    const detected = detectOctavePassage(measure);
    expect(detected).toMatchObject({
      rulesVersion: 5,
      pattern: 'runs',
      affectedHands: ['right'],
    });
    expectEligibleDistinctPair(detected!);
    const context = contextWithMethods(
      detected,
      'octave-five-note-alternating-accents',
      'octave-progressive-groups-with-rests',
    );

    const exercises = generateOctavePracticeExercises(measure, context);
    expect(exercises[0].title).toBe('Right Hand Alternating Accent Octaves');
    expect(exercises[1].title).toBe('Right Hand Progressive Octave Groups');
    expect(musicXmlMeasureCount(exercises[0].musicXml)).toBe(2);
    expect(musicXmlMeasureCount(exercises[1].musicXml)).toBe(1);

    for (const measureIndex of [0, 1]) {
      const events = noteEvents(exercises[0].musicXml, measureIndex);
      const attacks = events.filter((event) => eventPitch(event) && !event.chord);
      expect(events).toHaveLength(16);
      expect(events.every((event) => event.type === 'eighth' && event.durationQuarterNotes === 0.5)).toBe(true);
      expect(attacks.map(eventArticulation)).toEqual([
        'accent', null, null, null, 'accent', null, null, null,
      ]);
    }
    expect((exercises[0].musicXml.match(/<fifths>1<\/fifths>/g) ?? [])).toHaveLength(2);

    const progressiveEvents = noteEvents(exercises[1].musicXml);
    const progressiveAttacks = progressiveEvents.filter((event) => eventPitch(event) && !event.chord);
    expect(progressiveAttacks.map((event) => eventPitch(event)?.step)).toEqual([
      'C', 'C', 'D', 'C', 'D', 'E',
    ]);
    expect(progressiveEvents.filter((event) => event.rest)).toHaveLength(3);
    expect(progressiveEvents.every((event) => event.type === 'eighth' && event.durationQuarterNotes === 0.5)).toBe(true);
    const progressiveTimeline = progressiveEvents.filter((event) => !event.chord);
    expect(progressiveTimeline.map(eventBeams)).toEqual([
      [],
      [],
      [{ number: 1, value: 'begin' }],
      [{ number: 1, value: 'end' }],
      [],
      [{ number: 1, value: 'begin' }],
      [{ number: 1, value: 'continue' }],
      [{ number: 1, value: 'end' }],
      [],
    ]);
    expect(progressiveEvents.filter((event) => event.chord).every(
      (event) => eventBeams(event).length === 0,
    )).toBe(true);
    expect(exercises[1].musicXml).toContain('>Etc.<');
    expect(exercises[1].musicXml).toContain('<fifths>1</fifths>');
    expect(getOctavePracticeRules().methods.find(
      (method) => method.id === 'octave-progressive-groups-with-rests',
    )?.notation).toMatchObject({
      groupCountFormula: 'min(3, totalOctaveAttacks - 1)',
      maximumGeneratedGroups: 3,
      restAfterEveryGroup: true,
      directionAfterFinalGroup: 'Etc.',
    });
    expectSafeExercises(exercises);
  });

  it.each([
    {
      name: 'sharp',
      fifths: 1,
      attacks: [
        { lower: { step: 'E' as const, octave: 5 } },
        { lower: { step: 'F' as const, alter: 1, octave: 5 } },
        { lower: { step: 'G' as const, octave: 5 } },
      ],
      expectedFive: [['E', 0], ['F', 1], ['G', 0], ['A', 0], ['B', 0]],
    },
    {
      name: 'flat',
      fifths: -1,
      attacks: [
        { lower: { step: 'A' as const, octave: 4 } },
        { lower: { step: 'B' as const, alter: -1, octave: 4 } },
        { lower: { step: 'C' as const, octave: 5 } },
      ],
      expectedFive: [['A', 0], ['B', -1], ['C', 0], ['D', 0], ['E', 0]],
    },
  ])('engraves expanding and accent drills for a three-attack $name-key run', ({ fifths, attacks, expectedFive }) => {
    const measure = extractMeasureForAnalysis(octaveScore(attacks, [], fifths), 0);
    const detected = detectOctavePassage(measure);
    expect(detected).toMatchObject({ pattern: 'runs' });
    expectEligibleDistinctPair(detected!);
    const context = contextWithMethods(
      detected,
      'octave-expanding-five-note-pattern',
      'octave-five-note-alternating-accents',
    );

    const exercises = generateOctavePracticeExercises(measure, context);
    expect(exercises[0].title).toBe('Right Hand Expanding Five-Note Pattern');
    expect(exercises[1].title).toBe('Right Hand Alternating Accent Octaves');
    expect(musicXmlMeasureCount(exercises[0].musicXml)).toBe(4);
    expect(musicXmlMeasureCount(exercises[1].musicXml)).toBe(2);

    const expansionFive = noteEvents(exercises[0].musicXml, 3)
      .filter((event) => eventPitch(event) && !event.chord)
      .slice(0, 5)
      .map((event) => [eventPitch(event)?.step, eventPitch(event)?.alter ?? 0]);
    const accentFive = noteEvents(exercises[1].musicXml, 0)
      .filter((event) => eventPitch(event) && !event.chord)
      .slice(0, 5)
      .map((event) => [eventPitch(event)?.step, eventPitch(event)?.alter ?? 0]);
    expect(expansionFive).toEqual(expectedFive);
    expect(accentFive).toEqual(expectedFive);
    for (const exercise of exercises) {
      expect(exercise.musicXml).toContain(`<fifths>${fifths}</fifths>`);
      for (let measureIndex = 0; measureIndex < musicXmlMeasureCount(exercise.musicXml); measureIndex += 1) {
        expect(noteEvents(exercise.musicXml, measureIndex).every(
          (event) => event.type === 'eighth' && event.durationQuarterNotes === 0.5,
        )).toBe(true);
      }
    }
    expect(exercises[0].musicXml).toContain(
      'Play each pattern as fast and correctly as possible to build endurance.',
    );
    expectSafeExercises(exercises);
  });

  it('engraves separate and dotted drills for short jumps with correct RH/LH black-key fingering', () => {
    const jumping = [
      { lower: { step: 'C' as const, octave: 5 } },
      { lower: { step: 'F' as const, alter: 1, octave: 5 } },
      { lower: { step: 'C' as const, octave: 5 } },
    ];
    const leftJumping = jumping.map((attack) => ({
      lower: { ...attack.lower, octave: 2 },
    }));
    const measure = extractMeasureForAnalysis(octaveScore(jumping, leftJumping, 1), 0);
    const detected = detectOctavePassage(measure);
    expect(detected).toMatchObject({
      pattern: 'jumps',
      affectedHands: ['right', 'left'],
    });
    expectEligibleDistinctPair(detected!);
    const context = contextWithMethods(
      detected,
      'octave-separate-finger-lines',
      'octave-dotted-rhythm-variations',
    );

    const exercises = generateOctavePracticeExercises(measure, context);
    const outer = noteEvents(exercises[0].musicXml, 0);
    const thumbs = noteEvents(exercises[0].musicXml, 1);
    expect(outer.filter((event) => event.staff === 1).map(eventFingering)).toEqual(['5', '4', '5']);
    expect(outer.filter((event) => event.staff === 2).map(eventFingering)).toEqual(['5', '4', '5']);
    expect(thumbs.filter((event) => event.staff === 1).map(eventFingering)).toEqual(['1', '1', '1']);
    expect(thumbs.filter((event) => event.staff === 2).map(eventFingering)).toEqual(['1', '1', '1']);
    expect(outer.filter((event) => event.staff === 1).map((event) => eventPitch(event)?.octave)).toEqual([6, 6, 6]);
    expect(outer.filter((event) => event.staff === 2).map((event) => eventPitch(event)?.octave)).toEqual([2, 2, 2]);
    expect(thumbs.filter((event) => event.staff === 1).map((event) => eventPitch(event)?.octave)).toEqual([5, 5, 5]);
    expect(thumbs.filter((event) => event.staff === 2).map((event) => eventPitch(event)?.octave)).toEqual([3, 3, 3]);

    expect(exercises[0].musicXml).toContain('<staves>2</staves>');
    expect(exercises[0].musicXml).toContain('<backup>');
    const longShort = noteEvents(exercises[1].musicXml, 0).filter((event) => event.staff === 1 && !event.chord);
    const shortLong = noteEvents(exercises[1].musicXml, 1).filter((event) => event.staff === 1 && !event.chord);
    expect(longShort.map((event) => event.durationQuarterNotes)).toEqual([0.75, 0.25, 0.75]);
    expect(shortLong.map((event) => event.durationQuarterNotes)).toEqual([0.25, 0.75, 0.25]);
    expectSafeExercises(exercises);
  });

  it('engraves separate and dotted drills for repeated octaves', () => {
    const repeated = Array.from({ length: 4 }, () => ({
      lower: { step: 'A' as const, octave: 2 },
    }));
    const measure = extractMeasureForAnalysis(octaveScore([], repeated), 0);
    const detected = detectOctavePassage(measure);
    expect(detected).toMatchObject({
      pattern: 'repeated',
      affectedHands: ['left'],
    });
    expectEligibleDistinctPair(detected!);
    const context = contextWithMethods(
      detected,
      'octave-separate-finger-lines',
      'octave-dotted-rhythm-variations',
    );

    const exercises = generateOctavePracticeExercises(measure, context);
    expect(exercises[0].title).toBe('Left Hand Separate Finger Lines');
    expect(exercises[1].title).toBe('Left Hand Dotted-Rhythm Variations');
    expect(noteEvents(exercises[0].musicXml, 0).map(eventFingering)).toEqual(['5', '5', '5', '5']);
    expect(noteEvents(exercises[0].musicXml, 1).map(eventFingering)).toEqual(['1', '1', '1', '1']);
    for (const measureIndex of [0, 1]) {
      expect(noteEvents(exercises[0].musicXml, measureIndex).map(eventBeams)).toEqual([
        [{ number: 1, value: 'begin' }],
        [{ number: 1, value: 'continue' }],
        [{ number: 1, value: 'continue' }],
        [{ number: 1, value: 'end' }],
      ]);
    }

    const longShort = noteEvents(exercises[1].musicXml, 0);
    const shortLong = noteEvents(exercises[1].musicXml, 1);
    const longShortRoots = longShort.filter((event) => !event.chord);
    const shortLongRoots = shortLong.filter((event) => !event.chord);
    expect(longShortRoots.map(eventBeams)).toEqual([
      [{ number: 1, value: 'begin' }],
      [
        { number: 1, value: 'continue' },
        { number: 2, value: 'backward hook' },
      ],
      [{ number: 1, value: 'continue' }],
      [
        { number: 1, value: 'end' },
        { number: 2, value: 'backward hook' },
      ],
    ]);
    expect(shortLongRoots.map(eventBeams)).toEqual([
      [
        { number: 1, value: 'begin' },
        { number: 2, value: 'forward hook' },
      ],
      [{ number: 1, value: 'continue' }],
      [
        { number: 1, value: 'continue' },
        { number: 2, value: 'forward hook' },
      ],
      [{ number: 1, value: 'end' }],
    ]);
    expect([...longShort, ...shortLong].filter((event) => event.chord).every(
      (event) => eventBeams(event).length === 0,
    )).toBe(true);
    expectSafeExercises(exercises);
  });

  it('writes both hands together for jump methods but separately for run methods', () => {
    const jumps = pitches(['C', 'G', 'C'], 5);
    const jumpMeasure = extractMeasureForAnalysis(octaveScore(
      jumps,
      pitches(['C', 'G', 'C'], 2),
    ), 0);
    const jumpContext = contextWithMethods(
      detectOctavePassage(jumpMeasure),
      'octave-separate-finger-lines',
      'octave-dotted-rhythm-variations',
    );
    const jumpExercises = generateOctavePracticeExercises(jumpMeasure, jumpContext);
    for (const exercise of jumpExercises) {
      expect(exercise.musicXml).toContain('<staves>2</staves>');
      expect(exercise.musicXml).toContain('<backup>');
    }

    const run = [
      { lower: { step: 'E' as const, octave: 5 } },
      { lower: { step: 'F' as const, alter: 1, octave: 5 } },
      { lower: { step: 'G' as const, octave: 5 } },
    ];
    const leftRun = run.map((attack) => ({ lower: { ...attack.lower, octave: 2 } }));
    const runMeasure = extractMeasureForAnalysis(octaveScore(run, leftRun, 1), 0);
    const detectedRun = detectOctavePassage(runMeasure);
    expect(detectedRun).toMatchObject({ affectedHands: ['right', 'left'] });
    const runContext = contextWithMethods(
      detectedRun,
      'octave-expanding-five-note-pattern',
      'octave-five-note-alternating-accents',
    );
    const runExercises = generateOctavePracticeExercises(runMeasure, runContext);
    expect(musicXmlMeasureCount(runExercises[0].musicXml)).toBe(8);
    expect(musicXmlMeasureCount(runExercises[1].musicXml)).toBe(4);
    for (const exercise of runExercises) {
      expect(exercise.musicXml).not.toContain('<staves>2</staves>');
      expect(exercise.musicXml).not.toContain('<backup>');
      expect(exercise.musicXml).toContain('<sign>G</sign>');
      expect(exercise.musicXml).toContain('<sign>F</sign>');
    }
    expectSafeExercises(jumpExercises);
    expectSafeExercises(runExercises);
  });

  it('breaks octave consecutiveness at an intervening non-octave attack', () => {
    const measure = extractMeasureForAnalysis(octaveScore([
      { lower: { step: 'C', octave: 4 } },
      { lower: { step: 'G', octave: 4 } },
      {
        lower: { step: 'C', octave: 5 },
        upper: { step: 'G', octave: 5 },
      },
      { lower: { step: 'C', octave: 5 } },
      { lower: { step: 'G', octave: 5 } },
    ]), 0);
    const detected = detectOctavePassage(measure);
    expect(detected).toMatchObject({ pattern: 'jumps' });
    expect(detected?.sequences).toHaveLength(1);
    expect(detected?.sequences[0].attacks).toHaveLength(2);
    expect(detected?.sequences[0].attacks.map((attack) => attack.sourceOrdinal)).toEqual([0, 1]);
    const context = contextWithMethods(
      detected,
      'octave-separate-finger-lines',
      'octave-dotted-rhythm-variations',
    );
    const exercises = generateOctavePracticeExercises(measure, context);
    expectSafeExercises(exercises);
  });

  it('engraves separate and progressive drills for a long mixed octave passage', () => {
    const attacks = pitches(['C', 'D', 'D', 'A', 'B', 'B', 'C'], 4);
    const measure = extractMeasureForAnalysis(octaveScore(attacks), 0);
    const detected = detectOctavePassage(measure);
    expect(detected).toMatchObject({ pattern: 'long-mixed' });
    const context = contextWithMethods(
      detected,
      'octave-separate-finger-lines',
      'octave-progressive-groups-with-rests',
    );
    const exercises = generateOctavePracticeExercises(measure, context);
    expect(exercises[1].musicXml).toContain('>Etc.<');
    expectSafeExercises(exercises);
  });

  it('preserves every detected octave attack in passages longer than twelve notes', () => {
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
    expectEligibleDistinctPair(context!);
    expectSafeExercises(generateOctavePracticeExercises(measure, context!));
  });

  it('cycles fewer than four source positions for exercise six and alternates repeated-pair accents', () => {
    const measure = extractMeasureForAnalysis(octaveScore([
      { lower: { step: 'C', octave: 5 } },
      { lower: { step: 'F', alter: 1, octave: 5 } },
      { lower: { step: 'D', octave: 5 } },
    ], [], 1), 0);
    const context = contextWithMethods(
      detectOctavePassage(measure),
      'octave-repeated-pairs-alternating-accents',
      'octave-separate-finger-lines',
    );
    const exercises = generateOctavePracticeExercises(measure, context);
    const repeatedPairs = exercises[0];

    expect(musicXmlMeasureCount(repeatedPairs.musicXml)).toBe(2);
    expect((repeatedPairs.musicXml.match(/<score-partwise\b/g) ?? [])).toHaveLength(1);
    expect((repeatedPairs.musicXml.match(/<print new-system="yes"\/>/g) ?? [])).toHaveLength(1);
    expect((repeatedPairs.musicXml.match(/<fifths>1<\/fifths>/g) ?? [])).toHaveLength(2);

    const expectedSteps = ['C', 'C', 'F', 'F', 'D', 'D', 'C', 'C'];
    const expectedAlters = [0, 0, 1, 1, 0, 0, 0, 0];
    for (const measureIndex of [0, 1]) {
      const events = noteEvents(repeatedPairs.musicXml, measureIndex);
      const roots = events.filter((event) => eventPitch(event) && !event.chord);
      const outerNotes = events.filter((event) => eventPitch(event) && event.chord);
      expect(events).toHaveLength(16);
      expect(events.every(
        (event) => event.type === 'eighth' && event.durationQuarterNotes === 0.5,
      )).toBe(true);
      expect(roots.map((event) => eventPitch(event)?.step)).toEqual(expectedSteps);
      expect(roots.map((event) => eventPitch(event)?.alter ?? 0)).toEqual(expectedAlters);
      expect(roots.map(eventFingering)).toEqual(Array.from({ length: 8 }, () => '1'));
      expect(outerNotes.map(eventFingering)).toEqual(['5', '5', '4', '4', '5', '5', '5', '5']);
      expect(roots.map(eventArticulation)).toEqual(measureIndex === 0
        ? ['accent', null, 'accent', null, 'accent', null, 'accent', null]
        : [null, 'accent', null, 'accent', null, 'accent', null, 'accent']);
    }

    expect(exercises[1].musicXml).not.toBe(repeatedPairs.musicXml);
    expect((exercises[1].musicXml.match(/<score-partwise\b/g) ?? [])).toHaveLength(1);
    expect((exercises[1].musicXml.match(/<print new-system="yes"\/>/g) ?? [])).toHaveLength(1);
    expectSafeExercises(exercises);
  });

  it('truncates exercise six to four positions and writes affected hands on separate systems', () => {
    const right = [
      { lower: { step: 'A' as const, octave: 4 } },
      { lower: { step: 'B' as const, alter: -1, octave: 4 } },
      { lower: { step: 'E' as const, octave: 5 } },
      { lower: { step: 'C' as const, octave: 5 } },
      { lower: { step: 'F' as const, octave: 5 } },
    ];
    const left = right.map(({ lower }) => ({ lower: { ...lower, octave: lower.octave - 2 } }));
    const score = octaveScore(right, left, -1).replace(
      '<key><fifths>-1</fifths></key>',
      '<key number="1"><fifths>1</fifths></key><key number="2"><fifths>-1</fifths></key>',
    );
    const measure = extractMeasureForAnalysis(score, 0);
    const context = contextWithMethods(
      detectOctavePassage(measure),
      'octave-repeated-pairs-alternating-accents',
      'octave-dotted-rhythm-variations',
    );
    const exercises = generateOctavePracticeExercises(measure, context);
    const repeatedPairs = exercises[0];

    expect(musicXmlMeasureCount(repeatedPairs.musicXml)).toBe(4);
    expect(repeatedPairs.musicXml).not.toContain('<staves>2</staves>');
    expect(repeatedPairs.musicXml).not.toContain('<backup>');
    expect((repeatedPairs.musicXml.match(/<print new-system="yes"\/>/g) ?? [])).toHaveLength(3);
    expect((repeatedPairs.musicXml.match(/<fifths>1<\/fifths>/g) ?? [])).toHaveLength(2);
    expect((repeatedPairs.musicXml.match(/<fifths>-1<\/fifths>/g) ?? [])).toHaveLength(2);

    for (const measureIndex of [0, 1, 2, 3]) {
      const events = noteEvents(repeatedPairs.musicXml, measureIndex);
      const roots = events.filter((event) => eventPitch(event) && !event.chord);
      const chordNotes = events.filter((event) => eventPitch(event) && event.chord);
      expect(roots.map((event) => eventPitch(event)?.step)).toEqual([
        'A', 'A', 'B', 'B', 'E', 'E', 'C', 'C',
      ]);
      expect(roots.map((event) => eventPitch(event)?.alter ?? 0)).toEqual([
        0, 0, -1, -1, 0, 0, 0, 0,
      ]);
      expect(roots.some((event) => eventPitch(event)?.step === 'F')).toBe(false);
      expect(events.every(
        (event) => event.type === 'eighth' && event.durationQuarterNotes === 0.5,
      )).toBe(true);
      expect(roots.map(eventArticulation)).toEqual(measureIndex % 2 === 0
        ? ['accent', null, 'accent', null, 'accent', null, 'accent', null]
        : [null, 'accent', null, 'accent', null, 'accent', null, 'accent']);

      if (measureIndex < 2) {
        expect(roots.map(eventFingering)).toEqual(Array.from({ length: 8 }, () => '1'));
        expect(chordNotes.map(eventFingering)).toEqual(['5', '5', '4', '4', '5', '5', '5', '5']);
      } else {
        expect(roots.map(eventFingering)).toEqual(['5', '5', '4', '4', '5', '5', '5', '5']);
        expect(chordNotes.map(eventFingering)).toEqual(Array.from({ length: 8 }, () => '1'));
      }
    }
    expectSafeExercises(exercises);
  });

  it('rejects exercise four for jumps and exercise five before four consecutive octaves', () => {
    const jumpMeasure = extractMeasureForAnalysis(octaveScore(pitches(['C', 'G', 'C'], 5)), 0);
    const jumpContext = contextWithMethods(
      detectOctavePassage(jumpMeasure),
      'octave-five-note-alternating-accents',
      'octave-separate-finger-lines',
    );
    expect(() => generateOctavePracticeExercises(jumpMeasure, jumpContext)).toThrow();

    const shortRunMeasure = extractMeasureForAnalysis(octaveScore(pitches(['C', 'D', 'E'], 5)), 0);
    const shortRunContext = contextWithMethods(
      detectOctavePassage(shortRunMeasure),
      'octave-progressive-groups-with-rests',
      'octave-separate-finger-lines',
    );
    expect(() => generateOctavePracticeExercises(shortRunMeasure, shortRunContext)).toThrow();

    const longRunMeasure = extractMeasureForAnalysis(octaveScore(pitches(['C', 'D', 'E', 'F'], 5)), 0);
    const longRunContext = contextWithMethods(
      detectOctavePassage(longRunMeasure),
      'octave-progressive-groups-with-rests',
      'octave-separate-finger-lines',
    );
    expect(() => generateOctavePracticeExercises(longRunMeasure, longRunContext)).not.toThrow();
  });

  it('keeps isolated, non-octave, cross-voice, enharmonic, and tie-stop material on the generic path', () => {
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

  it('accepts an octave surrounding an inner chord tone and excludes that inner tone from exercises', () => {
    const measure = extractMeasureForAnalysis(octaveScore([
      { lower: { step: 'C', octave: 5 }, inner: { step: 'G', octave: 5 } },
      { lower: { step: 'D', octave: 5 }, inner: { step: 'A', octave: 5 } },
      { lower: { step: 'E', octave: 5 }, inner: { step: 'B', octave: 5 } },
    ]), 0);
    const detected = detectOctavePassage(measure);
    expect(detected?.pattern).toBe('runs');
    expect(detected?.sequences[0].attacks).toHaveLength(3);
    const context = contextWithMethods(
      detected,
      'octave-expanding-five-note-pattern',
      'octave-five-note-alternating-accents',
    );
    const exercises = generateOctavePracticeExercises(measure, context);
    const firstExpansionPitches = noteEvents(exercises[0].musicXml, 0)
      .filter((event) => eventPitch(event))
      .map((event) => eventPitch(event)?.step);
    expect(new Set(firstExpansionPitches)).toEqual(new Set(['C', 'D']));
    expectSafeExercises(exercises);
  });
});
