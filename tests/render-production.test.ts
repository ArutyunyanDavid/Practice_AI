import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import type {
  AITransport,
  AnalysisInput,
  AnalysisModelSettings,
} from '../server/openai.js';
import { extractMeasureForAnalysis } from '../server/measure.js';
import { assertMusicXml } from '../server/xml.js';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scoresDirectory = path.join(projectDirectory, 'scores');
const expectedScoreFilenames = [
  'Czerny_Etude_1.mscz',
  'Czerny_etude_49.mscz',
  'Czerny_etude_50.mscz',
] as const;

interface TransportCall {
  filename: string;
  route: 'guided' | 'octave' | 'czerny50';
}

class RenderAnalysisTransport implements AITransport {
  readonly calls: TransportCall[] = [];

  async probe(): Promise<void> {
    throw new Error('The production score regression does not run a connection probe.');
  }

  async analyze(
    _model: string,
    input: AnalysisInput,
    settings: AnalysisModelSettings,
  ): Promise<unknown> {
    if (settings.reasoningEffort !== 'medium') {
      throw new Error('The production analysis did not request medium reasoning effort.');
    }

    if (input.czerny50Practice) {
      const passage = input.czerny50Practice.passages[0];
      if (!passage) throw new Error('Czerny Etude No. 50 did not expose an eligible passage.');
      this.calls.push({ filename: input.scoreFilename, route: 'czerny50' });
      return {
        analysis: 'The main challenge is keeping this eight note passage even and relaxed. Practice in clear rhythmic groups before restoring the written rhythm.',
        passageId: passage.id,
        methodIds: ['dotted-rhythmic-pairs', 'four-fast-four-slow'],
      };
    }

    if (input.octavePractice) {
      this.calls.push({ filename: input.scoreFilename, route: 'octave' });
      return {
        analysis: 'The main challenge is landing these octaves evenly without tension. Practice slowly with a free wrist before increasing the tempo.',
      };
    }

    if (input.scoreFilename === 'Czerny_Etude_1.mscz') {
      this.calls.push({ filename: input.scoreFilename, route: 'guided' });
      return {
        analysis: 'The main challenge is keeping this rapid scale passage even and clear. Practice short rhythmic groups slowly before joining the full line.',
        techniqueId: 'scales-chromatic-runs',
        exercises: [
          {
            methodId: 'scale-short-groups',
            title: 'Four Note Scale Groups',
            explanationSentences: [
              'This scale passage needs even movement across each adjacent four note group.',
              'Practice each group slowly with a relaxed hand and an even sound.',
            ],
            transformation: 'rhythmic-loop',
            notation: {
              staves: [{
                clef: 'bass',
                events: ['C', 'D', 'E', 'F'].map((step) => ({
                  kind: 'notes',
                  duration: 'eighth',
                  pitches: [{ step, alter: 0, octave: 3 }],
                  articulation: 'none',
                })),
              }],
            },
          },
          {
            methodId: 'scale-rhythm-variants',
            title: 'Dotted Scale Rhythm',
            explanationSentences: [
              'This rhythm variation develops control between neighboring notes in the scale.',
              'Alternate long and short values slowly before restoring the original rhythm.',
            ],
            transformation: 'accent-variation',
            notation: {
              staves: [{
                clef: 'bass',
                events: ['C', 'D', 'E', 'F'].map((step, index) => ({
                  kind: 'notes',
                  duration: index % 2 === 0 ? 'dotted-eighth' : '16th',
                  pitches: [{ step, alter: 0, octave: 3 }],
                  articulation: 'none',
                })),
              }],
            },
          },
        ],
      };
    }

    throw new Error(`The committed score fixture did not select its expected practice route: ${input.scoreFilename}`);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Render production score assets', () => {
  it('opens and analyzes all committed Czerny scores without MuseScore installed', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'practice-ai-render-test-'));
    temporaryDirectories.push(temporaryDirectory);
    const transport = new RenderAnalysisTransport();
    let museScoreResolutionCalls = 0;
    const { app } = createApp({
      scoresDirectory,
      cacheDirectory: path.join(temporaryDirectory, 'cache'),
      museScoreResolver: async () => {
        museScoreResolutionCalls += 1;
        return null;
      },
      openAI: {
        apiKey: 'render-test-key',
        model: 'render-test-model',
        transport,
      },
    });

    const listing = await request(app).get('/api/scores').expect(200);
    const scores = listing.body.scores as Array<Record<string, unknown>>;
    expect(scores.length).toBeGreaterThanOrEqual(expectedScoreFilenames.length);
    for (const filename of expectedScoreFilenames) {
      expect(scores.filter((score) => score.filename === filename)).toHaveLength(1);
    }
    expect(new Set(scores.map((score) => score.id)).size).toBe(scores.length);
    for (const score of scores) {
      expect(score).toMatchObject({
        format: '.mscz',
        requiresConversion: true,
        isValid: true,
      });
      expect(String(score.relativePath)).not.toContain('.musicxml-exports');
    }

    for (const filename of expectedScoreFilenames) {
      const score = scores.find((candidate) => candidate.filename === filename);
      expect(score).toBeDefined();
      const scoreId = String(score!.id);

      const content = await request(app)
        .get(`/api/scores/${scoreId}/content`)
        .expect('Content-Type', /musicxml/)
        .expect('X-Score-Cache', 'preconverted')
        .expect(200);
      expect(() => assertMusicXml(content.text)).not.toThrow();
      const sourceMeasure = extractMeasureForAnalysis(content.text, 0);
      expect(sourceMeasure.parts.length).toBeGreaterThan(0);
      expect(sourceMeasure.parts.flatMap((part) => part.events).length).toBeGreaterThan(0);

      const analysis = await request(app)
        .post(`/api/scores/${scoreId}/measures/0/analyze`)
        .send({ requestId: `render-${filename}` })
        .expect(200);
      expect(analysis.body.analysis).toMatchObject({
        scoreId,
        scoreTitle: score!.title,
        measure: { index: 0, label: sourceMeasure.label },
        model: 'render-test-model',
        reasoningEffort: 'medium',
      });
      const exercises = analysis.body.analysis.exercises as Array<Record<string, unknown>>;
      expect(exercises).toHaveLength(2);
      expect(exercises[0].title).not.toBe(exercises[1].title);
      expect(exercises[0].musicXml).not.toBe(exercises[1].musicXml);
      for (const exercise of exercises) {
        const exerciseXml = String(exercise.musicXml);
        expect(() => assertMusicXml(exerciseXml)).not.toThrow();
        const generatedMeasure = extractMeasureForAnalysis(exerciseXml, 0);
        expect(generatedMeasure.parts.flatMap((part) => part.events).length).toBeGreaterThan(0);
      }
    }

    expect(museScoreResolutionCalls).toBe(0);
    expect(transport.calls).toEqual([
      { filename: 'Czerny_Etude_1.mscz', route: 'guided' },
      { filename: 'Czerny_etude_49.mscz', route: 'octave' },
      { filename: 'Czerny_etude_50.mscz', route: 'czerny50' },
    ]);
  });
});
