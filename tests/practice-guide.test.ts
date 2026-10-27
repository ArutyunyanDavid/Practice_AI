import { describe, expect, it } from 'vitest';
import { assertMusicXml } from '../server/xml.js';
import { extractMeasureForAnalysis } from '../server/measure.js';
import {
  AIGuidedMeasureAnalysisSchema,
  getPracticeGuideContext,
  getPracticeGuideRules,
  getPracticeGuideRulesFileReadCount,
  materializeGuidedMeasureAnalysis,
  practiceGuidePromptSummary,
} from '../server/practice-guide.js';
import { getOctavePracticeRules } from '../server/octave-rules.js';

const guideFixtureXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1"><measure number="4">
    <attributes><divisions>4</divisions><staves>2</staves>
      <key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>
      <clef number="1"><sign>G</sign><line>2</line></clef>
      <clef number="2"><sign>F</sign><line>4</line></clef>
    </attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>C</step><octave>6</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
    <backup><duration>16</duration></backup>
    <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><type>half</type><staff>2</staff></note>
    <note><pitch><step>G</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><type>half</type><staff>2</staff></note>
  </measure></part>
</score-partwise>`;

const sourceMeasure = extractMeasureForAnalysis(guideFixtureXml, 0);

const expectedSelections = [
  ['octaves', 'octave-separate-finger-lines', 'octave-dotted-rhythm-variations'],
  ['chord-jumps', 'chord-upper-note-targets', 'chord-lower-group-targets'],
  ['scales-chromatic-runs', 'scale-short-groups', 'scale-rhythm-variants'],
  ['arpeggios-broken-chords', 'arpeggio-blocked-cells', 'arpeggio-reduced-landings'],
  ['single-note-leaps', 'leap-departure-arrival-pairs', 'leap-arrival-targets'],
  ['repeated-notes-chords', 'repetition-release-reset', 'repetition-short-groups'],
  ['double-notes', 'double-note-separate-lines', 'double-note-slow-groups'],
  ['trills-ornaments', 'ornament-slow-alternation', 'ornament-short-groups'],
  ['hands-polyrhythms', 'coordination-hands-separately', 'coordination-timing-skeleton'],
  ['melody-accompaniment', 'melody-alone', 'melody-harmonic-skeleton'],
  ['general', 'general-focused-reduction', 'general-contrasting-variation'],
] as const;

function guidedPlan(
  techniqueId: (typeof expectedSelections)[number][0],
  firstMethodId: (typeof expectedSelections)[number][1],
  secondMethodId: (typeof expectedSelections)[number][2],
) {
  return {
    analysis: `The main challenge fits the ${techniqueId} practice category. Practice the focused pattern slowly, then return to the measure when it feels even and relaxed.`,
    techniqueId,
    exercises: [
      {
        methodId: firstMethodId,
        title: 'Focused Source Study',
        explanationSentences: [
          'Practice the selected source tones slowly with relaxed and accurate movement.',
          'Return to the complete measure after the pattern feels secure and even.',
        ],
        transformation: 'voice-isolation',
        notation: {
          staves: [{
            clef: 'treble',
            events: [
              { kind: 'notes', duration: 'quarter', pitches: [{ step: 'C', alter: 0, octave: 5 }], articulation: 'none' },
              { kind: 'notes', duration: 'quarter', pitches: [{ step: 'E', alter: 0, octave: 5 }], articulation: 'none' },
            ],
          }],
        },
      },
      {
        methodId: secondMethodId,
        title: 'Contrasting Source Pattern',
        explanationSentences: [
          'This contrasting study clarifies another supported movement in the selected passage.',
          'Keep every motion easy and restore the written musical context afterward.',
        ],
        transformation: 'rhythmic-loop',
        notation: {
          staves: [{
            clef: 'treble',
            events: [
              { kind: 'notes', duration: 'eighth', pitches: [{ step: 'G', alter: 0, octave: 5 }], articulation: 'tenuto' },
              { kind: 'rest', duration: 'eighth', pitches: [], articulation: 'none' },
              { kind: 'notes', duration: 'quarter', pitches: [{ step: 'C', alter: 0, octave: 6 }], articulation: 'none' },
            ],
          }],
        },
      },
    ],
  };
}

describe('expanded piano practice guide', () => {
  it('uses the concise shared analysis contract', () => {
    const valid = guidedPlan('general', 'general-focused-reduction', 'general-contrasting-variation');
    expect(AIGuidedMeasureAnalysisSchema.safeParse(valid).success).toBe(true);
    expect(AIGuidedMeasureAnalysisSchema.safeParse({
      ...valid,
      analysis: 'This is only one sentence.',
    }).success).toBe(false);
  });

  it('loads one validated JSON singleton containing all ten techniques and no runtime DOCX dependency', () => {
    const first = getPracticeGuideRules();
    const second = getPracticeGuideRules();
    const octaveRules = getOctavePracticeRules();
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(getPracticeGuideRulesFileReadCount()).toBe(1);
    expect(first).toMatchObject({
      schemaVersion: 4,
      id: 'expanded-piano-practice-guide',
      source: {
        document: 'PracticeAI_Expanded_Piano_Practice_Guide.docx',
        sha256: '45039aadf85bf2c81d84a95a1d36569f7558aee55b0b82d48d04d2ef54c70126',
        treatAsTeachingReferenceOnly: true,
        loadDocumentAtRuntime: false,
      },
      globalSelection: { exerciseCount: 2, fallbackTechniqueId: 'general' },
    });
    expect(first.techniques).toHaveLength(10);
    expect(new Set(first.techniques.map((technique) => technique.id)).size).toBe(10);
    expect(getPracticeGuideContext()).toEqual({
      rulesVersion: 4,
      ruleSetId: 'expanded-piano-practice-guide',
    });
    expect(practiceGuidePromptSummary()).toMatchObject({
      rulesVersion: 4,
      ruleSetId: 'expanded-piano-practice-guide',
      techniques: expect.any(Array),
    });

    const mirroredOctaves = first.techniques.find((technique) => technique.id === 'octaves');
    const mirroredMethods = mirroredOctaves?.methods.map((method) => ({
      id: method.id,
      title: method.title,
      instructions: method.instructions,
      passes: method.notation.passes,
    }));
    const canonicalMethods = octaveRules.methods.map((method) => ({
      id: method.id,
      title: method.title,
      instructions: method.instructions,
      passes: method.notation.passes,
    }));
    expect(first.octaveEngine).toMatchObject({
      schemaVersion: octaveRules.schemaVersion,
      sourceRuleFile: 'czerny-etude-49-practice-rules.json',
      sourceSha256: octaveRules.source.sha256,
      selection: octaveRules.selection,
    });
    expect(mirroredOctaves?.sourceRuleFile).toBe('czerny-etude-49-practice-rules.json');
    expect(mirroredMethods).toEqual(canonicalMethods);
    expect(canonicalMethods.map((method) => method.id)).toEqual([
      'octave-separate-finger-lines',
      'octave-dotted-rhythm-variations',
      'octave-expanding-five-note-pattern',
      'octave-five-note-alternating-accents',
      'octave-progressive-groups-with-rests',
      'octave-repeated-pairs-alternating-accents',
    ]);
    expect(JSON.stringify({ engine: first.octaveEngine, technique: mirroredOctaves })).not.toMatch(
      /octave-finger-lines|octave-dotted-rhythms|octave-secure-landings|octave-release-reset/,
    );
  });

  it.each(expectedSelections)(
    'validates %s method selection and generates exactly two safe visual scores',
    (techniqueId, firstMethodId, secondMethodId) => {
      const parsed = AIGuidedMeasureAnalysisSchema.parse(
        guidedPlan(techniqueId, firstMethodId, secondMethodId),
      );
      const generated = materializeGuidedMeasureAnalysis(parsed, sourceMeasure);
      expect(generated.exercises).toHaveLength(2);
      for (const exercise of generated.exercises) {
        expect(exercise.explanationSentences).toHaveLength(2);
        expect(exercise.musicXml).toContain('<score-partwise version="4.0">');
        expect(exercise.musicXml).not.toMatch(/<!DOCTYPE|<!ENTITY/i);
        expect(assertMusicXml(exercise.musicXml)['score-partwise']).toBeTruthy();
      }
    },
  );

  it('rejects a method from the wrong technique and any invented pitch or register', () => {
    const wrongMethod = AIGuidedMeasureAnalysisSchema.parse(guidedPlan(
      'scales-chromatic-runs',
      'chord-upper-note-targets',
      'scale-rhythm-variants',
    ));
    expect(() => materializeGuidedMeasureAnalysis(wrongMethod, sourceMeasure))
      .toThrow(/methods.*expanded guide/i);

    const invented = guidedPlan(
      'arpeggios-broken-chords',
      'arpeggio-blocked-cells',
      'arpeggio-reduced-landings',
    );
    invented.exercises[1].notation.staves[0].events[0].pitches = [
      { step: 'F', alter: 1, octave: 7 },
    ];
    const parsedInvented = AIGuidedMeasureAnalysisSchema.parse(invented);
    expect(() => materializeGuidedMeasureAnalysis(parsedInvented, sourceMeasure))
      .toThrow(/pitch or register.*selected measure/i);
  });

  it('rejects extra fields and fewer than two exercises before MusicXML generation', () => {
    const invalid = {
      ...guidedPlan('chord-jumps', 'chord-upper-note-targets', 'chord-lower-group-targets'),
      musicXml: '<!DOCTYPE unsafe>',
    };
    expect(AIGuidedMeasureAnalysisSchema.safeParse(invalid).success).toBe(false);
    expect(AIGuidedMeasureAnalysisSchema.safeParse({
      ...invalid,
      musicXml: undefined,
      exercises: invalid.exercises.slice(0, 1),
    }).success).toBe(false);
  });
});
