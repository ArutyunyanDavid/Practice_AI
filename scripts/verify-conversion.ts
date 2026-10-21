import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ScoreLibrary } from '../server/library.js';
import { findMuseScoreExecutable } from '../server/musescore.js';

const projectDirectory = process.cwd();
const scoreFilename = 'Czerny_etude_49.mscz';
const cacheRoot = path.join(projectDirectory, '.cache');
await mkdir(cacheRoot, { recursive: true });
const scratch = await mkdtemp(path.join(cacheRoot, 'conversion-test-'));

try {
  const executable = await findMuseScoreExecutable();
  if (!executable) throw new Error('MuseScore Studio was not found.');

  const scoresDirectory = path.join(scratch, 'scores');
  const conversionCache = path.join(scratch, 'converted');
  await mkdir(scoresDirectory, { recursive: true });
  await copyFile(
    path.join(projectDirectory, 'scores', scoreFilename),
    path.join(scoresDirectory, scoreFilename),
  );

  const library = new ScoreLibrary({
    scoresDirectory,
    cacheDirectory: conversionCache,
    museScorePath: executable,
  });
  const scores = await library.list();
  if (
    scores.length !== 1
    || scores[0].filename !== scoreFilename
    || scores[0].format !== '.mscz'
    || !scores[0].isValid
  ) {
    throw new Error(`Native score discovery failed: ${JSON.stringify(scores)}`);
  }
  if (scores[0].title !== 'Czerny Étude No. 49' || scores[0].composer !== 'Carl Czerny') {
    throw new Error(`Featured display metadata was not applied: ${JSON.stringify(scores[0])}`);
  }

  const first = await library.content(scores[0].id);
  const second = await library.content(scores[0].id);
  if (first.cacheStatus !== 'miss' || second.cacheStatus !== 'hit') {
    throw new Error(`Unexpected cache states: ${first.cacheStatus}, ${second.cacheStatus}`);
  }
  if (!first.xml.includes('<score-partwise')) throw new Error('Converted output is not partwise MusicXML.');

  console.log(JSON.stringify({
    ok: true,
    executable,
    discovered: scores[0].filename,
    title: scores[0].title,
    firstRequest: first.cacheStatus,
    secondRequest: second.cacheStatus,
    convertedBytes: Buffer.byteLength(first.xml),
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
