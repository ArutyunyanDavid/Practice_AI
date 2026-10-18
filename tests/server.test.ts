import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { createApp } from '../server/app.js';
import {
  assertMusicXml,
  extractMsczMuseScoreXml,
  extractMxlMusicXml,
  extractMuseScoreMetadata,
  extractMusicXmlMetadata,
} from '../server/xml.js';

const musicXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>Small Prelude</work-title></work>
  <movement-title>Movement ignored when work title exists</movement-title>
  <identification><creator type="composer">Ada Example</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><rest/><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

const museScoreXml = `<?xml version="1.0" encoding="UTF-8"?>
<museScore version="4.0">
  <Score>
    <metaTag name="workTitle">Native Prelude</metaTag>
    <metaTag name="composer">Grace Example</metaTag>
  </Score>
</museScore>`;

function mxlBytes(): Uint8Array {
  const container = `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="music/score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles>
    </container>`;
  return zipSync({
    'META-INF/container.xml': strToU8(container),
    'music/score.musicxml': strToU8(musicXml),
  });
}

describe('MusicXML helpers', () => {
  it('validates MusicXML with a standard external DOCTYPE and reads canonical metadata', () => {
    expect(() => assertMusicXml(musicXml)).not.toThrow();
    expect(extractMusicXmlMetadata(musicXml)).toEqual({
      title: 'Small Prelude',
      composer: 'Ada Example',
    });
  });

  it('reads MuseScore project metadata', () => {
    expect(extractMuseScoreMetadata(museScoreXml)).toEqual({
      title: 'Native Prelude',
      composer: 'Grace Example',
    });
  });

  it('follows the MXL container rootfile instead of guessing an inner filename', () => {
    expect(extractMxlMusicXml(mxlBytes())).toContain('<work-title>Small Prelude</work-title>');
  });

  it('rejects archives with traversal paths', () => {
    const unsafe = zipSync({ '../score.mscx': strToU8(museScoreXml) });
    expect(() => extractMsczMuseScoreXml(unsafe)).toThrow(/unsafe file path/i);
  });

  it('rejects non-MusicXML documents with a clear message', () => {
    expect(() => assertMusicXml('<document><title>Not a score</title></document>')).toThrow(/does not contain a MusicXML score/i);
  });
});

describe('score library API', () => {
  let root: string;
  let scoresDirectory: string;
  let cacheDirectory: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'practice-studio-test-'));
    scoresDirectory = path.join(root, 'scores');
    cacheDirectory = path.join(root, 'cache');
    await mkdir(scoresDirectory, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('discovers new scores on every refresh without registration', async () => {
    const { app } = createApp({ scoresDirectory, cacheDirectory });
    const empty = await request(app).get('/api/scores').expect(200);
    expect(empty.body.scores).toEqual([]);

    await mkdir(path.join(scoresDirectory, 'piano'), { recursive: true });
    await writeFile(path.join(scoresDirectory, 'piano', 'Small Prelude.musicxml'), musicXml);

    const refreshed = await request(app).get('/api/scores').expect(200);
    expect(refreshed.body.scores).toHaveLength(1);
    expect(refreshed.body.scores[0]).toMatchObject({
      title: 'Small Prelude',
      composer: 'Ada Example',
      relativePath: 'piano/Small Prelude.musicxml',
      format: '.musicxml',
      isValid: true,
      requiresConversion: false,
    });

    const content = await request(app)
      .get(`/api/scores/${refreshed.body.scores[0].id}/content`)
      .expect('Content-Type', /musicxml/)
      .expect('X-Score-Cache', 'not-needed')
      .expect(200);
    expect(content.text).toContain('<score-partwise');
  });

  it('normalizes compressed MXL scores before sending them to OSMD', async () => {
    await writeFile(path.join(scoresDirectory, 'Compressed.mxl'), mxlBytes());
    const { app } = createApp({ scoresDirectory, cacheDirectory });
    const listing = await request(app).get('/api/scores').expect(200);
    const score = listing.body.scores[0];
    expect(score).toMatchObject({ title: 'Small Prelude', format: '.mxl', isValid: true });

    const content = await request(app).get(`/api/scores/${score.id}/content`).expect(200);
    expect(content.text).toContain('<score-partwise');
  });

  it('keeps invalid files visible and returns a useful 422 error', async () => {
    await writeFile(path.join(scoresDirectory, 'Broken.xml'), '<score-partwise><measure>');
    const { app } = createApp({ scoresDirectory, cacheDirectory });
    const listing = await request(app).get('/api/scores').expect(200);
    const score = listing.body.scores[0];
    expect(score.isValid).toBe(false);
    expect(score.issue).toMatch(/not valid XML/i);

    const content = await request(app).get(`/api/scores/${score.id}/content`).expect(422);
    expect(content.body.error).toMatchObject({ code: 'INVALID_SCORE' });
  });

  it('does not expose arbitrary paths through score ids', async () => {
    const { app } = createApp({ scoresDirectory, cacheDirectory });
    const response = await request(app).get(`/api/scores/${'a'.repeat(64)}/content`).expect(404);
    expect(response.body.error.code).toBe('SCORE_NOT_FOUND');
  });
});
