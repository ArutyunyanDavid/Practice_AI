import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import {
  BUNDLED_MUSICXML_DIRECTORY,
  convertMuseScoreFile,
  findMuseScoreExecutable,
  sourceScoreSha256,
} from '../server/musescore.js';
import { assertMusicXml } from '../server/xml.js';

const nativeExtensions = new Set(['.mscz', '.mscx']);

async function nativeScores(directory: string): Promise<string[]> {
  const matches: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...await nativeScores(entryPath));
    } else if (entry.isFile() && nativeExtensions.has(path.extname(entry.name).toLowerCase())) {
      matches.push(entryPath);
    }
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const scoresDirectory = path.resolve(process.env.SCORES_DIR ?? path.join(projectDirectory, 'scores'));
const cacheDirectory = path.resolve(process.env.SCORE_CACHE_DIR ?? path.join(projectDirectory, '.cache', 'scores'));
const exportsDirectory = path.join(scoresDirectory, BUNDLED_MUSICXML_DIRECTORY);
const executable = await findMuseScoreExecutable(process.env.MUSESCORE_PATH);

if (!executable) {
  throw new Error('MuseScore Studio 4 was not found. Install it or set MUSESCORE_PATH before generating exports.');
}

const sources = await nativeScores(scoresDirectory);
if (sources.length === 0) throw new Error(`No native MuseScore files were found in ${scoresDirectory}.`);
await mkdir(exportsDirectory, { recursive: true });

for (const sourcePath of sources) {
  const sourceSha256 = await sourceScoreSha256(sourcePath);
  const { xml } = await convertMuseScoreFile(sourcePath, cacheDirectory, executable);
  assertMusicXml(xml);
  if (await sourceScoreSha256(sourcePath) !== sourceSha256) {
    throw new Error(`${path.relative(scoresDirectory, sourcePath)} changed during conversion; run the command again.`);
  }
  const destination = path.join(exportsDirectory, `${sourceSha256}.musicxml`);
  await writeFile(destination, xml, 'utf8');
  console.log(`${path.relative(scoresDirectory, sourcePath)} -> ${path.relative(scoresDirectory, destination)}`);
}
