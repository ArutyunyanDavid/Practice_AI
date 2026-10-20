import { describe, expect, it } from 'vitest';
import { zodTextFormat } from 'openai/helpers/zod';
import { extractMeasureForAnalysis } from '../server/measure.js';
import { assertMusicXml } from '../server/xml.js';
import {
  AICzerny50AnalysisSchema,
  czerny50PracticePromptSummary,
  detectCzerny50Passage,
  generateCzerny50PracticeExercise,
  getCzerny50PracticeRules,
  getCzerny50RulesFileReadCount,
  materializeCzerny50PracticeAnalysis,
  validateCzerny50ExerciseMusicXml,
} from '../server/czerny50-practice.js';
import {
  CZERNY50_METHOD_IDS,
  CZERNY50_SCORE_FILENAME,
} from '../server/czerny50-rules.js';
import type { Czerny50MethodId } from '../server/czerny50-rules.js';

interface PitchSpec {
  step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  alter?: number;
  octave: number;
}

const rightPitches: PitchSpec[] = [
  { step: 'C', octave: 5 },
  { step: 'D', alter: -1, octave: 5 },
  { step: 'E', octave: 5 },
  { step: 'F', alter: 1, octave: 5 },
  { step: 'G', octave: 5 },
  { step: 'A', alter: -1, octave: 5 },
  { step: 'B', octave: 5 },
  { step: 'C', octave: 6 },
];

const leftPitches: PitchSpec[] = [
  { step: 'C', octave: 3 },
  { step: 'B', octave: 2 },
  { step: 'A', alter: -1, octave: 2 },
  { step: 'G', octave: 2 },
  { step: 'F', octave: 2 },
  { step: 'E', alter: -1, octave: 2 },
  { step: 'D', octave: 2 },
  { step: 'C', octave: 2 },
];

function pitchXml(pitch: PitchSpec): string {
  return `<pitch><step>${pitch.step}</step>${pitch.alter === undefined ? '' : `<alter>${pitch.alter}</alter>`}<octave>${pitch.octave}</octave></pitch>`;
}

function noteXml(
  pitch: PitchSpec,
  staff: 1 | 2,
  voice: string,
  options: { chord?: boolean; grace?: boolean; tieStop?: boolean } = {},
): string {
  return [
    '<note>',
    options.chord ? '<chord/>' : '',
    options.grace ? '<grace/>' : '',
    pitchXml(pitch),
    options.grace ? '' : '<duration>2</duration>',
    options.tieStop ? '<tie type="stop"/>' : '',
    `<voice>${voice}</voice><type>eighth</type><staff>${staff}</staff>`,
    options.tieStop ? '<notations><tied type="stop"/></notations>' : '',
    '</note>',
  ].join('');
}

function scoreXml(rightBody: string, leftBody = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano &amp; Study</part-name></score-part></part-list>
  <part id="P1"><measure number="50">
    <attributes>
      <divisions>4</divisions><key><fifths>-3</fifths><mode>minor</mode></key>
      <time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>
      <clef number="1"><sign>G</sign><line>2</line></clef>
      <clef number="2"><sign>F</sign><line>4</line></clef>
    </attributes>
    ${rightBody}
    ${leftBody ? `<backup><duration>16</duration></backup>${leftBody}` : ''}
  </measure></part>
</score-partwise>`;
}

function notes(pitches: PitchSpec[], staff: 1 | 2 = 1, voice = '1'): string {
  return pitches.map((pitch) => noteXml(pitch, staff, voice)).join('');
}

const sourceMeasure = extractMeasureForAnalysis(
  scoreXml(notes(rightPitches), notes(leftPitches, 2, '2')),
  0,
);
const sourceContext = detectCzerny50Passage(CZERNY50_SCORE_FILENAME, sourceMeasure)!;

function generatedNotes(xml: string, measureIndex: number) {
  return extractMeasureForAnalysis(xml, measureIndex).parts[0].events
    .filter((event) => event.kind === 'note');
}

function normalizedPitch(event: Record<string, unknown>) {
  const pitch = event.pitch as Record<string, unknown>;
  return {
    step: pitch.step,
    alter: pitch.alter ?? 0,
    octave: pitch.octave,
  };
}

describe('Czerny Etude No. 50 practice rules', () => {
  it('produces a strict Responses API schema supported by the OpenAI SDK', () => {
    expect(() => zodTextFormat(AICzerny50AnalysisSchema, 'czerny_50_measure_analysis')).not.toThrow();
  });

  it('loads and deeply freezes the validated six-method JSON singleton only once', () => {
    const first = getCzerny50PracticeRules();
    const second = getCzerny50PracticeRules();
    expect(first).toBe(second);
    expect(getCzerny50RulesFileReadCount()).toBe(1);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.methods)).toBe(true);
    expect(Object.isFrozen(first.methods[0].firstMeasureDurations)).toBe(true);
    expect(first).toMatchObject({
      schemaVersion: 1,
      source: {
        document: 'Czerny_etude_50.docx',
        sha256: '991cac369d843909779cbb34c1d5ad2dfade36981000af5546a66e14f5aef463',
        treatAsTeachingReferenceOnly: true,
        loadDocumentAtRuntime: false,
      },
      scope: {
        scoreFilename: CZERNY50_SCORE_FILENAME,
        passageNoteCount: 8,
        exerciseCount: 2,
      },
    });
    expect(first.methods.map((method) => method.id)).toEqual(CZERNY50_METHOD_IDS);
  });

  it('preserves every documented meter and duration pattern exactly', () => {
    const rules = getCzerny50PracticeRules();
    expect(rules.methods.map((method) => ({
      id: method.id,
      meter: `${method.meter.beats}/${method.meter.beatType}`,
      first: method.firstMeasureDurations,
      second: method.secondMeasureDurations,
    }))).toEqual([
      {
        id: 'dotted-rhythmic-pairs', meter: '4/4',
        first: ['dotted-eighth', 'sixteenth', 'dotted-eighth', 'sixteenth', 'dotted-eighth', 'sixteenth', 'dotted-eighth', 'sixteenth'],
        second: ['sixteenth', 'dotted-eighth', 'sixteenth', 'dotted-eighth', 'sixteenth', 'dotted-eighth', 'sixteenth', 'dotted-eighth'],
      },
      {
        id: 'four-fast-four-slow', meter: '3/4',
        first: ['sixteenth', 'sixteenth', 'sixteenth', 'sixteenth', 'eighth', 'eighth', 'eighth', 'eighth'],
        second: ['eighth', 'eighth', 'eighth', 'eighth', 'sixteenth', 'sixteenth', 'sixteenth', 'sixteenth'],
      },
      {
        id: 'two-fast-two-slow', meter: '3/4',
        first: ['sixteenth', 'sixteenth', 'eighth', 'eighth', 'sixteenth', 'sixteenth', 'eighth', 'eighth'],
        second: ['eighth', 'eighth', 'sixteenth', 'sixteenth', 'eighth', 'eighth', 'sixteenth', 'sixteenth'],
      },
      {
        id: 'long-note-outside', meter: '6/8',
        first: ['dotted-eighth', 'sixteenth', 'sixteenth', 'sixteenth', 'dotted-eighth', 'sixteenth', 'sixteenth', 'sixteenth'],
        second: ['sixteenth', 'sixteenth', 'sixteenth', 'dotted-eighth', 'sixteenth', 'sixteenth', 'sixteenth', 'dotted-eighth'],
      },
      {
        id: 'long-note-inside', meter: '6/8',
        first: ['sixteenth', 'dotted-eighth', 'sixteenth', 'sixteenth', 'sixteenth', 'dotted-eighth', 'sixteenth', 'sixteenth'],
        second: ['sixteenth', 'sixteenth', 'dotted-eighth', 'sixteenth', 'sixteenth', 'sixteenth', 'dotted-eighth', 'sixteenth'],
      },
      {
        id: 'long-notes-outside-inside', meter: '3/4',
        first: ['eighth', 'sixteenth', 'sixteenth', 'eighth', 'eighth', 'sixteenth', 'sixteenth', 'eighth'],
        second: ['sixteenth', 'eighth', 'eighth', 'sixteenth', 'sixteenth', 'eighth', 'eighth', 'sixteenth'],
      },
    ]);
  });
});

describe('Czerny Etude No. 50 passage detection', () => {
  it('finds independent right- and left-hand eight-note passages with stable allowlisted IDs', () => {
    expect(sourceContext.passages).toHaveLength(2);
    expect(sourceContext.passages.map((passage) => ({
      id: passage.id,
      hand: passage.hand,
      staff: passage.sourceStaff,
      voice: passage.voice,
      pitches: passage.pitches,
    }))).toEqual([
      {
        id: 'czerny50-passage-1', hand: 'right', staff: 1, voice: '1',
        pitches: rightPitches.map((pitch) => ({ ...pitch, alter: pitch.alter ?? 0 })),
      },
      {
        id: 'czerny50-passage-2', hand: 'left', staff: 2, voice: '2',
        pitches: leftPitches.map((pitch) => ({ ...pitch, alter: pitch.alter ?? 0 })),
      },
    ]);
    expect(sourceContext.passages[0].sourceOrders).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);

    const prompt = czerny50PracticePromptSummary(sourceContext);
    expect(prompt).toMatchObject({
      scoreFilename: CZERNY50_SCORE_FILENAME,
      requiredSelection: { passageCount: 1, methodCount: 2, distinctMethods: true },
      passages: [{ id: 'czerny50-passage-1', hand: 'right' }, { id: 'czerny50-passage-2', hand: 'left' }],
      methods: expect.arrayContaining(CZERNY50_METHOD_IDS.map((id) => expect.objectContaining({ id }))),
    });
    expect(JSON.stringify(prompt)).not.toContain('Piano & Study');
    expect(JSON.stringify(prompt)).not.toContain('"voice"');
  });

  it('creates each contiguous sliding eight-note window without changing pitch order', () => {
    const ninth = { step: 'D' as const, alter: 1, octave: 6 };
    const measure = extractMeasureForAnalysis(scoreXml(notes([...rightPitches, ninth])), 0);
    const context = detectCzerny50Passage(CZERNY50_SCORE_FILENAME, measure);
    expect(context?.passages).toHaveLength(2);
    expect(context?.passages[0].pitches[0]).toEqual({ step: 'C', alter: 0, octave: 5 });
    expect(context?.passages[1].pitches[0]).toEqual({ step: 'D', alter: -1, octave: 5 });
    expect(context?.passages[1].pitches[7]).toEqual({ step: 'D', alter: 1, octave: 6 });
  });

  it('never applies the document to another score filename', () => {
    expect(detectCzerny50Passage('Czerny_etude_49.mscz', sourceMeasure)).toBeNull();
    expect(detectCzerny50Passage('czerny_etude_50.mscz', sourceMeasure)).toBeNull();
  });

  it.each([
    ['grace', noteXml({ step: 'G', octave: 4 }, 1, '1', { grace: true })],
    ['tie stop', noteXml({ step: 'G', octave: 4 }, 1, '1', { tieStop: true })],
    ['chord', `${noteXml({ step: 'G', octave: 4 }, 1, '1')}${noteXml({ step: 'B', octave: 4 }, 1, '1', { chord: true })}`],
  ])('breaks eligibility at a %s attack', (_label, excludedAttack) => {
    const before = notes(rightPitches.slice(0, 4));
    const after = notes(rightPitches.slice(4));
    const measure = extractMeasureForAnalysis(scoreXml(`${before}${excludedAttack}${after}`), 0);
    expect(detectCzerny50Passage(CZERNY50_SCORE_FILENAME, measure)).toBeNull();
  });

  it('does not combine short fragments across rests, voices, or staffs', () => {
    const firstFour = notes(rightPitches.slice(0, 4));
    const rest = '<note><rest/><duration>2</duration><voice>1</voice><type>eighth</type><staff>1</staff></note>';
    const otherVoice = notes(rightPitches.slice(4), 1, '2');
    const measure = extractMeasureForAnalysis(scoreXml(`${firstFour}${rest}${otherVoice}`), 0);
    expect(detectCzerny50Passage(CZERNY50_SCORE_FILENAME, measure)).toBeNull();
  });

  it('does not combine note fragments across a forward timeline gap', () => {
    const firstFour = notes(rightPitches.slice(0, 4));
    const gap = '<forward><duration>2</duration></forward>';
    const lastFour = notes(rightPitches.slice(4));
    const measure = extractMeasureForAnalysis(scoreXml(`${firstFour}${gap}${lastFour}`), 0);
    expect(detectCzerny50Passage(CZERNY50_SCORE_FILENAME, measure)).toBeNull();
  });

  it('caps overlapping passage candidates before they enter the AI prompt', () => {
    const longLine = Array.from({ length: 40 }, (_unused, index) => rightPitches[index % rightPitches.length]);
    const measure = extractMeasureForAnalysis(scoreXml(notes(longLine)), 0);
    const context = detectCzerny50Passage(CZERNY50_SCORE_FILENAME, measure);
    expect(context?.passages).toHaveLength(16);
    expect((czerny50PracticePromptSummary(context!).passages as unknown[])).toHaveLength(16);
  });
});

describe('Czerny Etude No. 50 deterministic exercises', () => {
  it.each(CZERNY50_METHOD_IDS)('generates exact two-measure %s notation from the source pitches', (methodId) => {
    const rules = getCzerny50PracticeRules();
    const method = rules.methods.find((candidate) => candidate.id === methodId)!;
    const passage = sourceContext.passages[0];
    const exercise = generateCzerny50PracticeExercise(methodId, passage, sourceMeasure);
    const expectedDurations = [method.firstMeasureDurations, method.secondMeasureDurations]
      .map((durations) => durations.map((duration) => ({ sixteenth: 0.25, eighth: 0.5, 'dotted-eighth': 0.75 })[duration]));

    expect(exercise.title).toBe(`Right Hand - ${method.title}`);
    expect(exercise.explanationSentences).toEqual(method.instructionSentences);
    expect(exercise.explanationSentences).toHaveLength(2);
    for (const sentence of exercise.explanationSentences) {
      expect(sentence).toMatch(/^[^.!?;]+\.$/);
    }
    expect(exercise.musicXml.match(/<measure\b/g)).toHaveLength(2);
    expect(exercise.musicXml).toContain(`<time><beats>${method.meter.beats}</beats><beat-type>${method.meter.beatType}</beat-type></time>`);
    expect(exercise.musicXml).toContain('<key><fifths>-3</fifths><mode>minor</mode></key>');
    expect(exercise.musicXml).toContain('<clef><sign>G</sign><line>2</line></clef>');
    expect(exercise.musicXml).not.toMatch(/<!DOCTYPE|<!ENTITY/i);
    expect(assertMusicXml(exercise.musicXml)['score-partwise']).toBeTruthy();

    [0, 1].forEach((measureIndex) => {
      const actual = generatedNotes(exercise.musicXml, measureIndex);
      expect(actual.map(normalizedPitch)).toEqual(passage.pitches);
      expect(actual.map((event) => event.durationQuarterNotes)).toEqual(expectedDurations[measureIndex]);
    });
    if (method.directionAboveExercise) {
      expect(exercise.musicXml).toContain(`<words>${method.directionAboveExercise}</words>`);
    }
    validateCzerny50ExerciseMusicXml(exercise.musicXml, passage, methodId);
  });

  it('uses the affected left hand and source bass clef', () => {
    const exercise = generateCzerny50PracticeExercise(
      'dotted-rhythmic-pairs',
      sourceContext.passages[1],
      sourceMeasure,
    );
    expect(exercise.title).toMatch(/^Left Hand/);
    expect(exercise.musicXml).toContain('<clef><sign>F</sign><line>4</line></clef>');
    expect(generatedNotes(exercise.musicXml, 0).map(normalizedPitch)).toEqual(
      sourceContext.passages[1].pitches,
    );
  });

  it('materializes exactly two distinct visual exercises chosen by AI', () => {
    const result = materializeCzerny50PracticeAnalysis({
      analysis: 'The right hand needs rhythmic control through this fast eight-note line.',
      passageId: 'czerny50-passage-1',
      methodIds: ['four-fast-four-slow', 'long-note-inside'],
    }, sourceMeasure, sourceContext);
    expect(result.analysis).toMatch(/right hand/i);
    expect(result.exercises).toHaveLength(2);
    expect(result.exercises.map((exercise) => exercise.title)).toEqual([
      'Right Hand - Four Fast Notes and Four Slow Notes',
      'Right Hand - Moving the Long Note Within the Group',
    ]);
    result.exercises.forEach((exercise) => {
      expect(exercise.explanationSentences).toHaveLength(2);
      expect(exercise.musicXml.match(/<measure\b/g)).toHaveLength(2);
    });
  });

  it('lets the schema describe duplicates but rejects them before generation', () => {
    const duplicatePlan = AICzerny50AnalysisSchema.parse({
      analysis: 'This passage needs a controlled rhythmic variation.',
      passageId: 'czerny50-passage-1',
      methodIds: ['two-fast-two-slow', 'two-fast-two-slow'],
    });
    expect(() => materializeCzerny50PracticeAnalysis(duplicatePlan, sourceMeasure, sourceContext))
      .toThrow(/invalid Czerny Etude No\. 50 exercise selection/i);
  });

  it('rejects invented methods, passage IDs, and extra AI fields', () => {
    expect(AICzerny50AnalysisSchema.safeParse({
      analysis: 'A valid analysis.',
      passageId: 'czerny50-passage-1',
      methodIds: ['invented-method', 'two-fast-two-slow'],
    }).success).toBe(false);
    expect(AICzerny50AnalysisSchema.safeParse({
      analysis: 'A valid analysis.',
      passageId: 'czerny50-passage-1',
      methodIds: ['dotted-rhythmic-pairs', 'two-fast-two-slow'],
      musicXml: '<!DOCTYPE unsafe>',
    }).success).toBe(false);

    const missingPassage = AICzerny50AnalysisSchema.parse({
      analysis: 'A valid analysis.',
      passageId: 'czerny50-passage-999',
      methodIds: ['dotted-rhythmic-pairs', 'two-fast-two-slow'],
    });
    expect(() => materializeCzerny50PracticeAnalysis(missingPassage, sourceMeasure, sourceContext))
      .toThrow(/invalid Czerny Etude No\. 50 exercise selection/i);
  });

  it('rejects structurally altered or unsafe MusicXML', () => {
    const passage = sourceContext.passages[0];
    const exercise = generateCzerny50PracticeExercise(
      'four-fast-four-slow',
      passage,
      sourceMeasure,
    );
    expect(() => validateCzerny50ExerciseMusicXml(
      exercise.musicXml.replace('<duration>1</duration>', '<duration>2</duration>'),
      passage,
      'four-fast-four-slow',
    )).toThrow(/MusicXML did not pass validation|invalid Czerny/i);
    expect(() => validateCzerny50ExerciseMusicXml(
      exercise.musicXml.replace('<score-partwise', '<!DOCTYPE score [<!ENTITY x "x">]><score-partwise'),
      passage,
      'four-fast-four-slow' as Czerny50MethodId,
    )).toThrow(/invalid Czerny|MusicXML did not pass validation/i);
  });
});
