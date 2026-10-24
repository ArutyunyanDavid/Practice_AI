import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { createApp } from '../server/app.js';
import { AppError } from '../server/errors.js';
import {
  AIAnalysisTextSchema,
  AIExerciseNotationSchema,
  AIMeasureAnalysisSchema,
  generateExerciseMusicXml,
  materializeMeasureAnalysis,
  validateAnalysisText,
  validateGeneratedExerciseMusicXml,
} from '../server/exercise-musicxml.js';
import { extractMeasureForAnalysis } from '../server/measure.js';
import { assertMusicXml } from '../server/xml.js';
import { OpenAIService } from '../server/openai.js';
import type { AITransport, AnalysisInput, AnalysisModelSettings } from '../server/openai.js';

const analysisXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Ordered Study</work-title></work>
  <identification><creator type="composer">Test Composer</creator></identification>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
    <score-part id="P2"><part-name>Optional Instrument</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes>
        <divisions>4</divisions><staves>2</staves>
        <key number="1"><fifths>2</fifths><mode>major</mode></key>
        <key number="2"><fifths>-1</fifths><mode>minor</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
    </measure>
    <measure number="1">
      <attributes>
        <key number="2"><fifths>-3</fifths><mode>minor</mode></key>
        <clef number="2"><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>
      </attributes>
      <note><rest measure="yes"/><duration>16</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
    </measure>
    <measure number="12A">
      <direction placement="above">
        <direction-type><words font-style="italic" default-x="20">molto energico</words></direction-type>
        <direction-type><dynamics><ff/></dynamics></direction-type>
        <direction-type><wedge type="crescendo" number="1" spread="12"/></direction-type>
        <sound tempo="144" dynamics="105"/>
      </direction>
      <note default-x="101" color="#000000" dynamics="92">
        <pitch><step>C</step><alter>1</alter><octave>5</octave></pitch>
        <duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff>
        <tie type="start"/><notations><articulations><staccato/></articulations><slur type="start" number="1"/></notations>
      </note>
      <note>
        <chord/><pitch><step>E</step><octave>5</octave></pitch>
        <duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff>
      </note>
      <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>8</duration></backup>
      <note>
        <pitch><step>G</step><octave>2</octave></pitch>
        <duration>8</duration><voice>2</voice><type>half</type><dot/><staff>2</staff>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <notations><technical><fingering>5</fingering></technical><ornaments><trill-mark/></ornaments></notations>
      </note>
      <barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward" times="2"/></barline>
    </measure>
  </part>
  <part id="P2">
    <measure number="0"><attributes><divisions>4</divisions></attributes><note><rest/><duration>4</duration></note></measure>
    <measure number="1"><note><rest/><duration>16</duration></note></measure>
    <measure number="12A"><note><rest measure="yes"/><duration>16</duration><voice>1</voice><type>whole</type></note></measure>
  </part>
</score-partwise>`;

const timewiseXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-timewise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <measure number="0" implicit="yes">
    <part id="P1">
      <attributes><divisions>2</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><rest/><duration>2</duration><voice>1</voice><type>quarter</type></note>
    </part>
  </measure>
  <measure number="7b">
    <part id="P1">
      <note><pitch><step>A</step><alter>-1</alter><octave>4</octave></pitch><duration>3</duration><voice>1</voice><type>quarter</type><dot/></note>
    </part>
  </measure>
</score-timewise>`;

const octaveApiXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Octave API Study</work-title></work>
  <identification><creator type="composer">Test Composer</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1"><measure number="8">
    <attributes><divisions>8</divisions><staves>2</staves>
      <time><beats>4</beats><beat-type>4</beat-type></time>
      <clef number="1"><sign>G</sign><line>2</line></clef>
      <clef number="2"><sign>F</sign><line>4</line></clef>
    </attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>eighth</type><staff>1</staff></note>
    <note><chord/><pitch><step>C</step><octave>6</octave></pitch><duration>4</duration><voice>1</voice><type>eighth</type><staff>1</staff></note>
    <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>eighth</type><staff>1</staff></note>
    <note><chord/><pitch><step>D</step><octave>6</octave></pitch><duration>4</duration><voice>1</voice><type>eighth</type><staff>1</staff></note>
    <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>eighth</type><staff>1</staff></note>
    <note><chord/><pitch><step>E</step><octave>6</octave></pitch><duration>4</duration><voice>1</voice><type>eighth</type><staff>1</staff></note>
  </measure></part>
</score-partwise>`;

const czerny50ApiXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1"><measure number="15">
    <attributes><divisions>4</divisions><key><fifths>-2</fifths><mode>minor</mode></key>
      <time><beats>4</beats><beat-type>4</beat-type></time>
      <staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef>
      <clef number="2"><sign>F</sign><line>4</line></clef>
    </attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type><staff>1</staff></note>
    <note><pitch><step>D</step><alter>-1</alter><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type><staff>1</staff></note>
    <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type><staff>1</staff></note>
    <note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type><staff>1</staff></note>
    <note><pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type><staff>1</staff></note>
    <note><pitch><step>A</step><alter>-1</alter><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type><staff>1</staff></note>
    <note><pitch><step>B</step><alter>-1</alter><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type><staff>1</staff></note>
    <note><pitch><step>C</step><octave>6</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type><staff>1</staff></note>
    <backup><duration>8</duration></backup>
    <note><pitch><step>C</step><octave>2</octave></pitch><duration>2</duration><voice>2</voice><type>eighth</type><staff>2</staff></note>
    <note><chord/><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>eighth</type><staff>2</staff></note>
    <note><pitch><step>D</step><octave>2</octave></pitch><duration>2</duration><voice>2</voice><type>eighth</type><staff>2</staff></note>
    <note><chord/><pitch><step>D</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>eighth</type><staff>2</staff></note>
    <note><pitch><step>E</step><octave>2</octave></pitch><duration>2</duration><voice>2</voice><type>eighth</type><staff>2</staff></note>
    <note><chord/><pitch><step>E</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>eighth</type><staff>2</staff></note>
  </measure></part>
</score-partwise>`;

const goodAnalysis = {
  analysis: 'The main challenge is balancing the bright upper chord against the sustained bass voice. Practice slowly so both layers stay clear and rhythmically steady.',
  techniqueId: 'general',
  exercises: [
    {
      methodId: 'general-focused-reduction',
      title: 'Blocked Balance',
      explanationSentences: [
        'This reduction isolates balance between the sustained bass and upper chord.',
        'Play each sonority slowly while keeping the upper notes light and relaxed.',
      ],
      transformation: 'blocked-sonorities',
      notation: {
        staves: [
          {
            clef: 'treble',
            events: [
              {
                kind: 'notes',
                duration: 'quarter',
                pitches: [
                  { step: 'C', alter: 1, octave: 5 },
                  { step: 'E', alter: 0, octave: 5 },
                ],
                articulation: 'staccato',
              },
              { kind: 'rest', duration: 'quarter', pitches: [], articulation: 'none' },
            ],
          },
          {
            clef: 'bass',
            events: [
              {
                kind: 'notes',
                duration: 'half',
                pitches: [{ step: 'G', alter: 0, octave: 2 }],
                articulation: 'tenuto',
              },
            ],
          },
        ],
      },
    },
    {
      methodId: 'general-contrasting-variation',
      title: 'Rhythmic Layers',
      explanationSentences: [
        'This loop clarifies the quick upper rhythm against the grounded lower pulse.',
        'Repeat the pattern evenly and increase speed only after five relaxed repetitions.',
      ],
      transformation: 'rhythmic-loop',
      notation: {
        staves: [
          {
            clef: 'treble',
            events: [
              {
                kind: 'notes',
                duration: 'eighth',
                pitches: [{ step: 'C', alter: 1, octave: 5 }],
                articulation: 'accent',
              },
              {
                kind: 'notes',
                duration: 'eighth',
                pitches: [{ step: 'E', alter: 0, octave: 5 }],
                articulation: 'none',
              },
              {
                kind: 'notes',
                duration: 'quarter',
                pitches: [{ step: 'G', alter: 0, octave: 4 }],
                articulation: 'tenuto',
              },
            ],
          },
        ],
      },
    },
  ],
};

function countedSentence(prefix: string, wordCount: number): string {
  return `${Array.from({ length: wordCount }, () => prefix).join(' ')}.`;
}

class FakeTransport implements AITransport {
  probeCalls = 0;
  analyzeCalls = 0;
  lastInput?: AnalysisInput;
  lastSettings?: AnalysisModelSettings;
  probeError?: unknown;
  analysisError?: unknown;
  result: unknown = goodAnalysis;
  waitForRelease = false;
  private releasePromise?: Promise<void>;
  private releaseOperation?: () => void;

  async probe(): Promise<void> {
    this.probeCalls += 1;
    if (this.probeError) throw this.probeError;
  }

  async analyze(_model: string, input: AnalysisInput, settings: AnalysisModelSettings): Promise<unknown> {
    this.analyzeCalls += 1;
    this.lastInput = input;
    this.lastSettings = settings;
    if (this.analysisError) throw this.analysisError;
    if (this.waitForRelease) {
      this.releasePromise ??= new Promise<void>((resolve) => { this.releaseOperation = resolve; });
      await this.releasePromise;
    }
    return this.result;
  }

  release() {
    this.releaseOperation?.();
  }
}

const roots: string[] = [];

async function fixture(transport?: AITransport, configured = true, scoreXml = analysisXml) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'practice-ai-test-'));
  roots.push(root);
  const scoresDirectory = path.join(root, 'scores');
  await mkdir(scoresDirectory, { recursive: true });
  await writeFile(path.join(scoresDirectory, 'Ordered Study.musicxml'), scoreXml);
  const created = createApp({
    scoresDirectory,
    cacheDirectory: path.join(root, 'cache'),
    openAI: {
      apiKey: configured ? 'test-key' : '',
      model: configured ? 'test-model' : '',
      transport,
    },
  });
  const listing = await request(created.app).get('/api/scores').expect(200);
  return { ...created, scoreId: listing.body.scores[0].id as string };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('concise AI analysis text', () => {
  it('accepts two or three complete sentences and normalizes whitespace', () => {
    expect(validateAnalysisText('The passage needs even control.\nPractice slowly with a relaxed hand.')).toBe(
      'The passage needs even control. Practice slowly with a relaxed hand.',
    );
    expect(AIAnalysisTextSchema.safeParse(
      'The rhythm is uneven. Practice slowly in short groups. Join the groups only when they feel secure.',
    ).success).toBe(true);
  });

  it('accepts exactly sixty words but rejects sixty-one', () => {
    const sixtyWords = `${countedSentence('First', 30)} ${countedSentence('Second', 30)}`;
    const sixtyOneWords = `${countedSentence('First', 30)} ${countedSentence('Second', 31)}`;
    expect(AIAnalysisTextSchema.safeParse(sixtyWords).success).toBe(true);
    expect(AIAnalysisTextSchema.safeParse(sixtyOneWords).success).toBe(false);
  });

  it.each([
    ['one sentence', 'Practice this passage slowly.'],
    ['four sentences', 'The rhythm is uneven. Practice slowly. Stay relaxed. Then restore the tempo.'],
    ['an unfinished final sentence', 'The rhythm is uneven. Practice slowly without a final stop'],
    ['blank text', '   '],
  ])('rejects %s', (_caseName, analysis) => {
    expect(AIAnalysisTextSchema.safeParse(analysis).success).toBe(false);
  });
});

describe('MusicXML measure extraction', () => {
  it('preserves timeline order, all parts and inherited multi-staff context', () => {
    const measure = extractMeasureForAnalysis(analysisXml, 2, 'printed label may differ');
    expect(measure).toMatchObject({ index: 2, label: '12A', scoreFormat: 'partwise' });
    expect(measure.parts).toHaveLength(2);

    const piano = measure.parts[0];
    expect(piano.startingContext).toMatchObject({ divisions: 4, staves: 2 });
    expect(piano.startingContext.clefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ staff: 1, sign: 'G', line: 2 }),
      expect.objectContaining({ staff: 2, sign: 'G', octaveChange: -1 }),
    ]));
    expect(piano.startingContext.keys).toEqual(expect.arrayContaining([
      expect.objectContaining({ staff: 1, fifths: 2 }),
      expect.objectContaining({ staff: 2, fifths: -3 }),
    ]));

    expect(piano.events.map((event) => event.kind)).toEqual([
      'direction', 'note', 'note', 'note', 'backup', 'note', 'barline',
    ]);
    const notes = piano.events.filter((event) => event.kind === 'note');
    expect(notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ onsetQuarterNotes: 0, voice: '1', staff: 1, pitch: { step: 'C', alter: 1, octave: 5 } }),
      expect.objectContaining({ onsetQuarterNotes: 0, chord: true, pitch: { step: 'E', octave: 5 } }),
      expect.objectContaining({ onsetQuarterNotes: 1, rest: expect.any(Object) }),
      expect.objectContaining({ onsetQuarterNotes: 0, durationQuarterNotes: 2, voice: '2', staff: 2 }),
    ]));
    const serialized = JSON.stringify(measure);
    expect(serialized).toContain('molto energico');
    expect(serialized).toContain('"name":"ff"');
    expect(serialized).not.toContain('default-x');
    expect(serialized).not.toContain('#000000');
  });

  it('rejects out-of-range indices instead of guessing from a printed label', () => {
    expect(() => extractMeasureForAnalysis(analysisXml, 99, '12A')).toThrow(/not present/i);
  });

  it('extracts score-timewise measures with inherited rhythmic context', () => {
    const measure = extractMeasureForAnalysis(timewiseXml, 1);
    expect(measure).toMatchObject({ index: 1, label: '7b', scoreFormat: 'timewise' });
    expect(measure.parts[0]).toMatchObject({
      name: 'Piano',
      startingContext: { divisions: 2, times: [{ beats: ['3'], beatTypes: ['4'] }] },
      events: [expect.objectContaining({
        kind: 'note',
        onsetQuarterNotes: 0,
        durationQuarterNotes: 1.5,
        dots: 1,
        pitch: { step: 'A', alter: -1, octave: 4 },
      })],
    });
  });
});

describe('OpenAI server API', () => {
  it('reports configuration, performs a live test through the transport and analyzes canonical score data', async () => {
    const transport = new FakeTransport();
    const { app, scoreId } = await fixture(transport);

    const initial = await request(app).get('/api/ai/status').expect(200);
    expect(initial.body).toMatchObject({
      status: 'not_verified',
      model: 'test-model',
      reasoningEffort: 'medium',
    });
    const tested = await request(app).post('/api/ai/test').expect(200);
    expect(tested.body.status).toBe('connected');
    expect(transport.probeCalls).toBe(1);

    const response = await request(app)
      .post(`/api/scores/${scoreId}/measures/2/analyze`)
      .send({ requestId: 'request-123', measureLabel: 'totally untrusted display label' })
      .expect(200);
    expect(response.body).toMatchObject({
      requestId: 'request-123',
      analysis: {
        scoreId,
        scoreTitle: 'Ordered Study',
        composer: 'Test Composer',
        measure: { index: 2, label: '12A' },
        analysis: goodAnalysis.analysis,
        model: 'test-model',
        reasoningEffort: 'medium',
      },
    });
    expect(response.body.analysis.exercises).toHaveLength(2);
    expect(response.body.analysis.exercises.map((exercise: Record<string, unknown>) => ({
      title: exercise.title,
      explanationSentences: exercise.explanationSentences,
    }))).toEqual(goodAnalysis.exercises.map(({ title, explanationSentences }) => ({
      title,
      explanationSentences,
    })));
    for (const exercise of response.body.analysis.exercises) {
      expect(exercise.musicXml).toContain('<score-partwise version="4.0">');
      expect(exercise).not.toHaveProperty('notation');
      expect(exercise).not.toHaveProperty('transformation');
      assertMusicXml(exercise.musicXml);
    }
    const firstGenerated = extractMeasureForAnalysis(response.body.analysis.exercises[0].musicXml, 0);
    expect(firstGenerated.parts[0].events.filter((event) => event.kind === 'note')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ staff: 1, onsetQuarterNotes: 0, pitch: { step: 'C', alter: 1, octave: 5 } }),
        expect.objectContaining({ staff: 1, onsetQuarterNotes: 0, chord: true, pitch: { step: 'E', octave: 5 } }),
        expect.objectContaining({ staff: 2, onsetQuarterNotes: 0, pitch: { step: 'G', octave: 2 } }),
      ]),
    );
    expect(response.body.analysis.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(transport.lastInput?.measure.label).toBe('12A');
    expect(transport.lastInput?.scoreFilename).toBe('Ordered Study.musicxml');
    expect(transport.lastInput?.practiceGuide).toEqual({
      rulesVersion: 4,
      ruleSetId: 'expanded-piano-practice-guide',
    });
    expect(transport.lastInput?.czerny50Practice).toBeNull();
    expect(transport.lastSettings).toEqual({ reasoningEffort: 'medium' });
  });

  it('accepts an AI-selected expanded-guide technique and validates its two method identifiers', async () => {
    const transport = new FakeTransport();
    const guidedScale = {
      ...structuredClone(goodAnalysis),
      techniqueId: 'scales-chromatic-runs',
      exercises: [
        { ...structuredClone(goodAnalysis.exercises[0]), methodId: 'scale-short-groups' },
        { ...structuredClone(goodAnalysis.exercises[1]), methodId: 'scale-rhythm-variants' },
      ],
    };
    guidedScale.exercises[1].notation.staves[0].events[2].pitches[0] = {
      step: 'G',
      alter: 0,
      octave: 2,
    };
    transport.result = guidedScale;
    const { app, scoreId } = await fixture(transport);
    const response = await request(app)
      .post(`/api/scores/${scoreId}/measures/2/analyze`)
      .send({ requestId: 'guided-scale-request' })
      .expect(200);
    expect(response.body.analysis.exercises).toHaveLength(2);
    expect(response.body.analysis.exercises[0].musicXml).toContain('<score-partwise version="4.0">');
    expect(response.body.analysis.exercises[1].musicXml).toContain('<score-partwise version="4.0">');

    const wrongMethodTransport = new FakeTransport();
    wrongMethodTransport.result = {
      ...structuredClone(goodAnalysis),
      techniqueId: 'chord-jumps',
      exercises: [
        { ...structuredClone(goodAnalysis.exercises[0]), methodId: 'scale-short-groups' },
        { ...structuredClone(goodAnalysis.exercises[1]), methodId: 'chord-lower-group-targets' },
      ],
    };
    const wrongFixture = await fixture(wrongMethodTransport);
    const rejected = await request(wrongFixture.app)
      .post(`/api/scores/${wrongFixture.scoreId}/measures/2/analyze`)
      .send({})
      .expect(502);
    expect(rejected.body.error.code).toBe('OPENAI_INVALID_RESPONSE');
    expect(rejected.body).not.toHaveProperty('analysis');
  });

  it('returns Not Configured without constructing or calling an AI transport', async () => {
    const transport = new FakeTransport();
    const { app, scoreId } = await fixture(transport, false);
    const status = await request(app).get('/api/ai/status').expect(200);
    expect(status.body).toMatchObject({ status: 'not_configured', model: null });
    await request(app).post('/api/ai/test').expect(200).expect(({ body }) => {
      expect(body.status).toBe('not_configured');
    });
    const failed = await request(app).post(`/api/scores/${scoreId}/measures/2/analyze`).send({}).expect(503);
    expect(failed.body.error.code).toBe('OPENAI_NOT_CONFIGURED');
    expect(transport.probeCalls).toBe(0);
    expect(transport.analyzeCalls).toBe(0);
  });

  it('treats either missing server setting as unconfigured and never reports unverified settings as connected', () => {
    expect(new OpenAIService({ apiKey: 'test-key', model: '' }).status().status).toBe('not_configured');
    expect(new OpenAIService({ apiKey: '', model: 'test-model' }).status().status).toBe('not_configured');
    expect(new OpenAIService({ apiKey: 'test-key', model: 'test-model' }).status()).toMatchObject({
      status: 'not_verified',
      model: 'test-model',
      reasoningEffort: 'medium',
    });
  });

  it('uses the loaded octave rules and backend notation generator for detected octave passages', async () => {
    const transport = new FakeTransport();
    transport.result = {
      analysis: 'The main challenge is a continuous stepwise octave run with aligned right hand landings. Practice slowly with a free wrist, then increase speed only when every octave feels secure.',
    };
    const { app, scoreId } = await fixture(transport, true, octaveApiXml);
    const response = await request(app)
      .post(`/api/scores/${scoreId}/measures/0/analyze`)
      .send({ requestId: 'octave-request' })
      .expect(200);
    expect(transport.lastInput?.octavePractice).toMatchObject({
      rulesVersion: 4,
      pattern: 'runs',
      affectedHands: ['right'],
      selectedMethods: [
        'octave-expanding-five-note-pattern',
        'octave-five-note-alternating-accents',
      ],
    });
    expect(transport.lastInput?.practiceGuide).toEqual({
      rulesVersion: 4,
      ruleSetId: 'expanded-piano-practice-guide',
    });
    expect(response.body.analysis.analysis).toContain('continuous stepwise octave run');
    expect(response.body.analysis.exercises).toHaveLength(2);
    expect(response.body.analysis.exercises.map((exercise: Record<string, unknown>) => exercise.title)).toEqual([
      'Right Hand Expanding Five-Note Pattern',
      'Right Hand Alternating Accent Octaves',
    ]);
    for (const exercise of response.body.analysis.exercises) {
      expect(exercise.explanationSentences).toHaveLength(2);
      expect(exercise.musicXml).toContain('<score-partwise version="4.0">');
      expect(exercise.musicXml).not.toMatch(/<!DOCTYPE|<!ENTITY/i);
      assertMusicXml(exercise.musicXml);
    }
  });

  it('uses the Czerny No. 50 reference for its eight-note line even over octave accompaniment', async () => {
    const transport = new FakeTransport();
    transport.result = {
      analysis: 'The main challenge is keeping the right hand even across eight fast notes. Practice in clear rhythmic groups with relaxed fingers before restoring the written rhythm.',
      passageId: 'czerny50-passage-1',
      methodIds: ['dotted-rhythmic-pairs', 'four-fast-four-slow'],
    };
    const service = new OpenAIService({
      apiKey: 'test-key',
      model: 'test-model',
      transport,
    });
    const measure = extractMeasureForAnalysis(czerny50ApiXml, 0);
    const result = await service.analyze({
      scoreId: 'czerny-50-id',
      scoreFilename: 'Czerny_etude_50.mscz',
      scoreTitle: 'Czerny Étude No. 50',
      composer: 'Carl Czerny',
      measure,
    });

    expect(transport.lastInput?.octavePractice).toBeNull();
    expect(transport.lastInput?.czerny50Practice).toMatchObject({
      rulesVersion: 1,
      scoreFilename: 'Czerny_etude_50.mscz',
      passages: [expect.objectContaining({
        id: 'czerny50-passage-1',
        hand: 'right',
        sourceStaff: 1,
        voice: '1',
      })],
    });
    expect(result.exercises.map((exercise) => exercise.title)).toEqual([
      'Right Hand - Dotted Rhythmic Pairs',
      'Right Hand - Four Fast Notes and Four Slow Notes',
    ]);
    for (const exercise of result.exercises) {
      expect(exercise.explanationSentences).toHaveLength(2);
      expect(exercise.musicXml.match(/<measure\b/g)).toHaveLength(2);
      assertMusicXml(exercise.musicXml);
    }
    const generatedPitches = extractMeasureForAnalysis(result.exercises[0].musicXml, 0)
      .parts[0].events
      .filter((event) => event.kind === 'note')
      .map((event) => event.pitch);
    expect(generatedPitches).toEqual([
      { step: 'C', alter: 0, octave: 5 },
      { step: 'D', alter: -1, octave: 5 },
      { step: 'E', alter: 0, octave: 5 },
      { step: 'F', alter: 0, octave: 5 },
      { step: 'G', alter: 0, octave: 5 },
      { step: 'A', alter: -1, octave: 5 },
      { step: 'B', alter: -1, octave: 5 },
      { step: 'C', alter: 0, octave: 6 },
    ]);
  });

  it('falls back to the octave-specific rules for an octave-only passage in Czerny No. 50', async () => {
    const transport = new FakeTransport();
    transport.result = {
      analysis: 'The main challenge is landing each right hand octave evenly without tension. Practice slowly with a free wrist, then increase speed only when every landing feels secure.',
    };
    const service = new OpenAIService({
      apiKey: 'test-key',
      model: 'test-model',
      transport,
    });
    await service.analyze({
      scoreId: 'czerny-50-octaves',
      scoreFilename: 'Czerny_etude_50.mscz',
      scoreTitle: 'Czerny Étude No. 50',
      composer: 'Carl Czerny',
      measure: extractMeasureForAnalysis(octaveApiXml, 0),
    });

    expect(transport.lastInput?.octavePractice).not.toBeNull();
    expect(transport.lastInput?.czerny50Practice).toBeNull();
  });

  it('coalesces simultaneous duplicate analysis requests into one OpenAI call', async () => {
    const transport = new FakeTransport();
    transport.waitForRelease = true;
    const { app, scoreId } = await fixture(transport);
    const first = request(app).post(`/api/scores/${scoreId}/measures/2/analyze`).send({ requestId: 'first' });
    const second = request(app).post(`/api/scores/${scoreId}/measures/2/analyze`).send({ requestId: 'second' });
    const firstPromise = first.then((response) => response);
    const secondPromise = second.then((response) => response);

    for (let attempt = 0; attempt < 50 && transport.analyzeCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(transport.analyzeCalls).toBe(1);
    // Give the second HTTP request time to enter the shared in-flight operation
    // before releasing the deliberately blocked transport.
    await new Promise((resolve) => setTimeout(resolve, 30));
    transport.release();
    const [firstResponse, secondResponse] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstResponse.body.requestId).toBe('first');
    expect(secondResponse.body.requestId).toBe('second');
    expect(transport.analyzeCalls).toBe(1);
  });

  it('rejects malformed model output instead of returning fewer than two exercises', async () => {
    const transport = new FakeTransport();
    transport.result = { ...goodAnalysis, exercises: goodAnalysis.exercises.slice(0, 1) };
    const { app, scoreId } = await fixture(transport);
    const response = await request(app).post(`/api/scores/${scoreId}/measures/2/analyze`).send({}).expect(502);
    expect(response.body.error.code).toBe('OPENAI_INVALID_RESPONSE');
  });

  it('rejects an analysis that is not two or three concise sentences', async () => {
    const transport = new FakeTransport();
    transport.result = { ...structuredClone(goodAnalysis), analysis: 'This is only one sentence.' };
    const { app, scoreId } = await fixture(transport);
    const response = await request(app)
      .post(`/api/scores/${scoreId}/measures/2/analyze`)
      .send({})
      .expect(502);
    expect(response.body.error.code).toBe('OPENAI_INVALID_RESPONSE');
    expect(response.body).not.toHaveProperty('analysis');
  });

  it('rejects raw model XML, extra fields, and invalid explanatory sentences atomically', async () => {
    const rawXmlTransport = new FakeTransport();
    const rawXmlResult = structuredClone(goodAnalysis) as typeof goodAnalysis & { musicXml?: string };
    rawXmlResult.musicXml = '<!DOCTYPE score [<!ENTITY unsafe SYSTEM "file:///private">]>';
    rawXmlTransport.result = rawXmlResult;
    const rawXmlFixture = await fixture(rawXmlTransport);
    const rawXmlResponse = await request(rawXmlFixture.app)
      .post(`/api/scores/${rawXmlFixture.scoreId}/measures/2/analyze`)
      .send({})
      .expect(502);
    expect(rawXmlResponse.body).toEqual({
      error: {
        code: 'OPENAI_INVALID_RESPONSE',
        message: 'OpenAI returned an incomplete analysis. Please try again.',
      },
    });
    expect(JSON.stringify(rawXmlResponse.body)).not.toContain('DOCTYPE');

    const sentenceTransport = new FakeTransport();
    const sentenceResult = structuredClone(goodAnalysis);
    sentenceResult.exercises[1].explanationSentences[1] = 'Practice this once. Then practice it again.';
    sentenceTransport.result = sentenceResult;
    const sentenceFixture = await fixture(sentenceTransport);
    const sentenceResponse = await request(sentenceFixture.app)
      .post(`/api/scores/${sentenceFixture.scoreId}/measures/2/analyze`)
      .send({})
      .expect(502);
    expect(sentenceResponse.body.error.code).toBe('OPENAI_INVALID_RESPONSE');
    expect(sentenceResponse.body).not.toHaveProperty('analysis');
  });

  it('generates deterministic MusicXML and rejects notation that no longer matches its plan', () => {
    const sourceMeasure = extractMeasureForAnalysis(analysisXml, 2);
    const parsed = AIMeasureAnalysisSchema.parse({
      analysis: goodAnalysis.analysis,
      exercises: goodAnalysis.exercises.map(({ methodId: _methodId, ...exercise }) => exercise),
    });
    const overlongExplanation = structuredClone(parsed);
    overlongExplanation.exercises[0].explanationSentences[0] = `${Array.from({ length: 21 }, () => 'word').join(' ')}.`;
    expect(() => materializeMeasureAnalysis(overlongExplanation, sourceMeasure))
      .toThrow(/exercise notation/i);
    const first = materializeMeasureAnalysis(parsed, sourceMeasure);
    const second = materializeMeasureAnalysis(parsed, sourceMeasure);
    expect(first).toEqual(second);
    expect(first.exercises[0].musicXml).not.toContain('<!DOCTYPE');
    expect(first.exercises[0].musicXml).not.toContain('<!ENTITY');
    expect(first.exercises[0].musicXml).not.toBe(first.exercises[1].musicXml);

    const generatedAgain = generateExerciseMusicXml(
      parsed.exercises[0].title,
      parsed.exercises[0].notation,
      sourceMeasure,
    );
    expect(generatedAgain).toBe(first.exercises[0].musicXml);
    const generatedMeasure = extractMeasureForAnalysis(generatedAgain, 0);
    expect(generatedMeasure.parts[0].events.filter((event) => event.kind === 'barline')).toEqual([
      expect.objectContaining({ location: 'left', style: 'heavy-light' }),
      expect.objectContaining({ location: 'right', style: 'light-heavy' }),
    ]);

    const alteredXml = generatedAgain.replace('<step>C</step>', '<step>D</step>');
    expect(() => validateGeneratedExerciseMusicXml(alteredXml, parsed.exercises[0].notation))
      .toThrow(/exercise notation/i);
    const alteredBarline = generatedAgain.replace('<bar-style>heavy-light</bar-style>', '<bar-style>regular</bar-style>');
    expect(() => validateGeneratedExerciseMusicXml(alteredBarline, parsed.exercises[0].notation))
      .toThrow(/exercise notation/i);
  });

  it('beams every consecutive short-note attack as one group and beams only chord roots', () => {
    const sourceMeasure = extractMeasureForAnalysis(analysisXml, 2);
    const notation = AIExerciseNotationSchema.parse({
      staves: [{
        clef: 'treble',
        events: Array.from({ length: 8 }, (_, index) => ({
          kind: 'notes',
          duration: '16th',
          pitches: index === 0
            ? [{ step: 'C', alter: 0, octave: 5 }, { step: 'E', alter: 0, octave: 5 }]
            : [{ step: ['D', 'E', 'F', 'G', 'A', 'B', 'C'][index - 1], alter: 0, octave: index === 7 ? 6 : 5 }],
          articulation: 'none',
        })),
      }],
    });
    const xml = generateExerciseMusicXml('Continuous Beam Study', notation, sourceMeasure);
    const notes = extractMeasureForAnalysis(xml, 0).parts[0].events
      .filter((event) => event.kind === 'note');
    const attacks = notes.filter((event) => !event.chord);

    expect(attacks).toHaveLength(8);
    expect(attacks.map((event) => event.beams)).toEqual([
      [{ number: 1, value: 'begin' }, { number: 2, value: 'begin' }],
      ...Array.from({ length: 6 }, () => [
        { number: 1, value: 'continue' },
        { number: 2, value: 'continue' },
      ]),
      [{ number: 1, value: 'end' }, { number: 2, value: 'end' }],
    ]);
    expect(notes.find((event) => event.chord)?.beams).toEqual([]);

    const alteredBeam = xml.replace('<beam number="1">begin</beam>', '<beam number="1">continue</beam>');
    expect(() => validateGeneratedExerciseMusicXml(alteredBeam, notation)).toThrow(/exercise notation/i);
  });

  it('restarts beams after rests and long notes while preserving mixed-rhythm beam hooks', () => {
    const sourceMeasure = extractMeasureForAnalysis(analysisXml, 2);
    const pitch = (step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G') => [{ step, alter: 0, octave: 5 }];
    const notation = AIExerciseNotationSchema.parse({
      staves: [{
        clef: 'treble',
        events: [
          { kind: 'notes', duration: '16th', pitches: pitch('C'), articulation: 'none' },
          { kind: 'notes', duration: 'eighth', pitches: pitch('D'), articulation: 'none' },
          { kind: 'notes', duration: '32nd', pitches: pitch('E'), articulation: 'none' },
          { kind: 'notes', duration: '16th', pitches: pitch('F'), articulation: 'none' },
          { kind: 'rest', duration: 'eighth', pitches: [], articulation: 'none' },
          { kind: 'notes', duration: '16th', pitches: pitch('G'), articulation: 'none' },
          { kind: 'notes', duration: '16th', pitches: pitch('A'), articulation: 'none' },
          { kind: 'notes', duration: 'quarter', pitches: pitch('B'), articulation: 'none' },
          { kind: 'notes', duration: 'eighth', pitches: pitch('C'), articulation: 'none' },
          { kind: 'notes', duration: '32nd', pitches: pitch('D'), articulation: 'none' },
        ],
      }],
    });
    const xml = generateExerciseMusicXml('Rest Boundary Study', notation, sourceMeasure);
    const notes = extractMeasureForAnalysis(xml, 0).parts[0].events
      .filter((event) => event.kind === 'note');

    expect(notes.map((event) => event.beams)).toEqual([
      [{ number: 1, value: 'begin' }, { number: 2, value: 'forward hook' }],
      [{ number: 1, value: 'continue' }],
      [{ number: 1, value: 'continue' }, { number: 2, value: 'begin' }, { number: 3, value: 'forward hook' }],
      [{ number: 1, value: 'end' }, { number: 2, value: 'end' }],
      [],
      [{ number: 1, value: 'begin' }, { number: 2, value: 'begin' }],
      [{ number: 1, value: 'end' }, { number: 2, value: 'end' }],
      [],
      [{ number: 1, value: 'begin' }],
      [{ number: 1, value: 'end' }, { number: 2, value: 'backward hook' }, { number: 3, value: 'backward hook' }],
    ]);
  });

  it('rejects unsafe pitches and duplicate exercise plans before returning any result', async () => {
    const transport = new FakeTransport();
    const invalid = structuredClone(goodAnalysis);
    invalid.exercises[1].notation.staves[0].events[0].pitches[0] = {
      step: 'C',
      alter: 0,
      octave: 0,
    };
    transport.result = invalid;
    const { app, scoreId } = await fixture(transport);
    const response = await request(app).post(`/api/scores/${scoreId}/measures/2/analyze`).send({}).expect(502);
    expect(response.body.error.code).toBe('OPENAI_INVALID_RESPONSE');
    expect(response.body).not.toHaveProperty('analysis');
  });

  it('maps OpenAI rate limits and timeouts to safe, helpful responses', async () => {
    const rateLimited = new FakeTransport();
    rateLimited.analysisError = new OpenAI.RateLimitError(
      429,
      { message: 'sensitive upstream detail' },
      'sensitive upstream detail',
      new Headers({ 'retry-after': '2' }),
    );
    const rateFixture = await fixture(rateLimited);
    const rateResponse = await request(rateFixture.app)
      .post(`/api/scores/${rateFixture.scoreId}/measures/2/analyze`)
      .send({})
      .expect(429);
    expect(rateResponse.headers['retry-after']).toBe('2');
    expect(rateResponse.body.error).toMatchObject({ code: 'OPENAI_RATE_LIMITED' });
    expect(JSON.stringify(rateResponse.body)).not.toContain('sensitive upstream detail');

    const timedOut = new FakeTransport();
    timedOut.probeError = new OpenAI.APIConnectionTimeoutError({ message: 'secret timeout detail' });
    const timeoutFixture = await fixture(timedOut);
    const testResponse = await request(timeoutFixture.app).post('/api/ai/test').expect(200);
    expect(testResponse.body).toMatchObject({ status: 'connection_failed' });
    expect(testResponse.body.message).toMatch(/too long/i);
    expect(JSON.stringify(testResponse.body)).not.toContain('secret timeout detail');
  });

  it('does not report an OpenAI connection failure for a local exercise-generation error', async () => {
    const transport = new FakeTransport();
    const { app, scoreId } = await fixture(transport);
    await request(app).post('/api/ai/test').expect(200).expect(({ body }) => {
      expect(body.status).toBe('connected');
    });
    transport.analysisError = new AppError(
      500,
      'OCTAVE_EXERCISE_INVALID',
      'The local exercise renderer could not prepare this excerpt.',
    );
    await request(app)
      .post(`/api/scores/${scoreId}/measures/2/analyze`)
      .send({})
      .expect(500);
    const status = await request(app).get('/api/ai/status').expect(200);
    expect(status.body.status).toBe('connected');
  });

  it('validates score and measure references before sending data to OpenAI', async () => {
    const transport = new FakeTransport();
    const { app } = await fixture(transport);
    await request(app).post(`/api/scores/${'a'.repeat(64)}/measures/0/analyze`).send({}).expect(404);
    await request(app).post('/api/scores/not-a-score/measures/0/analyze').send({}).expect(404);
    await request(app).post(`/api/scores/${'a'.repeat(64)}/measures/-1/analyze`).send({}).expect(400);
    expect(transport.analyzeCalls).toBe(0);
  });

  it('rate limits repeated analysis requests before they can create unbounded cost', async () => {
    const transport = new FakeTransport();
    const { app, scoreId } = await fixture(transport);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await request(app).post(`/api/scores/${scoreId}/measures/2/analyze`).send({}).expect(200);
    }
    const limited = await request(app)
      .post(`/api/scores/${scoreId}/measures/2/analyze`)
      .send({})
      .expect(429);
    expect(limited.body.error.code).toBe('ANALYSIS_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(transport.analyzeCalls).toBe(6);
  });
});
