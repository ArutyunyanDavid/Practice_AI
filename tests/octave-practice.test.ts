import { describe, expect, it } from 'vitest';
import { extractMeasureForAnalysis } from '../server/measure.js';
import {
  detectOctavePassage,
  generateOctavePracticeExercises,
} from '../server/octave-practice.js';
import {
  getOctavePracticeRules,
  getOctaveRulesFileReadCount,
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
  }
}

describe('standalone octave practice rules', () => {
  it('loads the versioned JSON singleton once with the new source and exactly five methods', () => {
    const first = getOctavePracticeRules();
    const second = getOctavePracticeRules();
    const methodIds = first.methods.map((method) => method.id);

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.schemaVersion).toBe(4);
    expect(getOctaveRulesFileReadCount()).toBe(1);
    expect(first.source).toEqual({
      document: 'Octaves_Exercises.docx',
      sha256: 'c6a43302e925103e038adc8a42e0c76345a06e88e7f1d425ae3d1ed45aee7569',
      treatAsTeachingReferenceOnly: true,
      loadDocumentAtRuntime: false,
    });
    expect(methodIds).toEqual([
      'octave-separate-finger-lines',
      'octave-dotted-rhythm-variations',
      'octave-expanding-five-note-pattern',
      'octave-five-note-alternating-accents',
      'octave-progressive-groups-with-rests',
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
    expect(first.selection.pairRules.map((rule) => rule.methodIds)).toEqual([
      ['octave-expanding-five-note-pattern', 'octave-five-note-alternating-accents'],
      ['octave-five-note-alternating-accents', 'octave-progressive-groups-with-rests'],
      ['octave-separate-finger-lines', 'octave-progressive-groups-with-rests'],
      ['octave-separate-finger-lines', 'octave-dotted-rhythm-variations'],
      ['octave-separate-finger-lines', 'octave-dotted-rhythm-variations'],
      ['octave-separate-finger-lines', 'octave-progressive-groups-with-rests'],
    ]);
  });
});

describe('octave passage detection and generation', () => {
  it('selects accent and progressive drills for a four-attack run and engraves their exact transformations', () => {
    const measure = extractMeasureForAnalysis(octaveScore([
      { lower: { step: 'C', octave: 5 } },
      { lower: { step: 'D', octave: 5 } },
      { lower: { step: 'E', octave: 5 } },
      { lower: { step: 'F', alter: 1, octave: 5 } },
    ], [], 1), 0);
    const context = detectOctavePassage(measure);
    expect(context).toMatchObject({
      rulesVersion: 4,
      pattern: 'runs',
      affectedHands: ['right'],
      selectedMethods: [
        'octave-five-note-alternating-accents',
        'octave-progressive-groups-with-rests',
      ],
    });

    const exercises = generateOctavePracticeExercises(measure, context!);
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
  ])('selects expanding and accent drills for a three-attack $name-key run', ({ fifths, attacks, expectedFive }) => {
    const measure = extractMeasureForAnalysis(octaveScore(attacks, [], fifths), 0);
    const context = detectOctavePassage(measure);
    expect(context).toMatchObject({
      pattern: 'runs',
      selectedMethods: [
        'octave-expanding-five-note-pattern',
        'octave-five-note-alternating-accents',
      ],
    });

    const exercises = generateOctavePracticeExercises(measure, context!);
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

  it('selects separate and dotted drills for short jumps with correct RH/LH black-key fingering', () => {
    const jumping = [
      { lower: { step: 'C' as const, octave: 5 } },
      { lower: { step: 'F' as const, alter: 1, octave: 5 } },
      { lower: { step: 'C' as const, octave: 5 } },
    ];
    const leftJumping = jumping.map((attack) => ({
      lower: { ...attack.lower, octave: 2 },
    }));
    const measure = extractMeasureForAnalysis(octaveScore(jumping, leftJumping, 1), 0);
    const context = detectOctavePassage(measure);
    expect(context).toMatchObject({
      pattern: 'jumps',
      affectedHands: ['right', 'left'],
      selectedMethods: [
        'octave-separate-finger-lines',
        'octave-dotted-rhythm-variations',
      ],
    });

    const exercises = generateOctavePracticeExercises(measure, context!);
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

  it('selects separate and dotted drills for repeated octaves', () => {
    const repeated = Array.from({ length: 4 }, () => ({
      lower: { step: 'A' as const, octave: 2 },
    }));
    const measure = extractMeasureForAnalysis(octaveScore([], repeated), 0);
    const context = detectOctavePassage(measure);
    expect(context).toMatchObject({
      pattern: 'repeated',
      affectedHands: ['left'],
      selectedMethods: [
        'octave-separate-finger-lines',
        'octave-dotted-rhythm-variations',
      ],
    });

    const exercises = generateOctavePracticeExercises(measure, context!);
    expect(exercises[0].title).toBe('Left Hand Separate Finger Lines');
    expect(exercises[1].title).toBe('Left Hand Dotted-Rhythm Variations');
    expect(noteEvents(exercises[0].musicXml, 0).map(eventFingering)).toEqual(['5', '5', '5', '5']);
    expect(noteEvents(exercises[0].musicXml, 1).map(eventFingering)).toEqual(['1', '1', '1', '1']);
    expectSafeExercises(exercises);
  });

  it('writes both hands together for jump methods but separately for run methods', () => {
    const jumps = pitches(['C', 'G', 'C'], 5);
    const jumpMeasure = extractMeasureForAnalysis(octaveScore(
      jumps,
      pitches(['C', 'G', 'C'], 2),
    ), 0);
    const jumpContext = detectOctavePassage(jumpMeasure);
    const jumpExercises = generateOctavePracticeExercises(jumpMeasure, jumpContext!);
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
    const runContext = detectOctavePassage(runMeasure);
    expect(runContext).toMatchObject({
      affectedHands: ['right', 'left'],
      selectedMethods: [
        'octave-expanding-five-note-pattern',
        'octave-five-note-alternating-accents',
      ],
    });
    const runExercises = generateOctavePracticeExercises(runMeasure, runContext!);
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
    const context = detectOctavePassage(measure);
    expect(context).toMatchObject({
      pattern: 'jumps',
      selectedMethods: [
        'octave-separate-finger-lines',
        'octave-dotted-rhythm-variations',
      ],
    });
    expect(context?.sequences).toHaveLength(1);
    expect(context?.sequences[0].attacks).toHaveLength(2);
    expect(context?.sequences[0].attacks.map((attack) => attack.sourceOrdinal)).toEqual([0, 1]);
    const exercises = generateOctavePracticeExercises(measure, context!);
    expectSafeExercises(exercises);
  });

  it('selects separate and progressive drills for a long mixed octave passage', () => {
    const attacks = pitches(['C', 'D', 'D', 'A', 'B', 'B', 'C'], 4);
    const measure = extractMeasureForAnalysis(octaveScore(attacks), 0);
    const context = detectOctavePassage(measure);
    expect(context).toMatchObject({
      pattern: 'long-mixed',
      selectedMethods: [
        'octave-separate-finger-lines',
        'octave-progressive-groups-with-rests',
      ],
    });
    const exercises = generateOctavePracticeExercises(measure, context!);
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
    expect(context?.selectedMethods).toEqual([
      'octave-five-note-alternating-accents',
      'octave-progressive-groups-with-rests',
    ]);
    expectSafeExercises(generateOctavePracticeExercises(measure, context!));
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
    const context = detectOctavePassage(measure);
    expect(context?.pattern).toBe('runs');
    expect(context?.sequences[0].attacks).toHaveLength(3);
    const exercises = generateOctavePracticeExercises(measure, context!);
    const firstExpansionPitches = noteEvents(exercises[0].musicXml, 0)
      .filter((event) => eventPitch(event))
      .map((event) => eventPitch(event)?.step);
    expect(new Set(firstExpansionPitches)).toEqual(new Set(['C', 'D']));
    expectSafeExercises(exercises);
  });
});
