import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './errors.js';
import { assertMusicXml, decodeXmlBuffer } from './xml.js';

const CONVERTER_VERSION = 'musicxml-v1';
const CONVERSION_TIMEOUT_MS = 120_000;

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function pathCandidates(command: string): string[] {
  const pathValue = process.env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => path.join(directory, command + extension.toLowerCase())));
}

export async function findMuseScoreExecutable(override = process.env.MUSESCORE_PATH): Promise<string | null> {
  const candidates: string[] = [];
  if (override) candidates.push(path.resolve(override));

  if (process.platform === 'win32') {
    candidates.push(...pathCandidates('MuseScore4'));
    candidates.push(...pathCandidates('MuseScore4.exe'));
    candidates.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'MuseScore 4', 'bin', 'MuseScore4.exe'));
    candidates.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'MuseScore 3', 'bin', 'MuseScore3.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push(...pathCandidates('mscore'));
    candidates.push('/Applications/MuseScore 4.app/Contents/MacOS/mscore');
  } else {
    for (const name of ['mscore', 'musescore', 'mscore4portable']) {
      candidates.push(...pathCandidates(name));
    }
  }

  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export const BUNDLED_MUSICXML_DIRECTORY = '.musicxml-exports';

async function stableSnapshot(sourcePath: string): Promise<{ bytes: Buffer; extension: string }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await stat(sourcePath);
    const bytes = await readFile(sourcePath);
    const after = await stat(sourcePath);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs && bytes.byteLength === after.size) {
      return { bytes, extension: path.extname(sourcePath).toLowerCase() };
    }
  }
  throw new AppError(409, 'SCORE_STILL_CHANGING', 'The score is still being copied. Wait a moment and try again.');
}

export async function sourceScoreSha256(sourcePath: string): Promise<string> {
  const { bytes } = await stableSnapshot(sourcePath);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readBundledMusicXmlExport(
  sourcePath: string,
  exportsDirectory: string,
): Promise<{ xml: string; sourceSha256: string } | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sourceSha256 = await sourceScoreSha256(sourcePath);
    const exportPath = path.join(exportsDirectory, `${sourceSha256}.musicxml`);
    let bytes: Buffer | null = null;
    try {
      bytes = await readFile(exportPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    // Confirm the source did not change while its matching export was being read.
    if (await sourceScoreSha256(sourcePath) !== sourceSha256) continue;
    if (!bytes) return null;

    try {
      const xml = decodeXmlBuffer(bytes);
      assertMusicXml(xml);
      return { xml, sourceSha256 };
    } catch (error) {
      throw new AppError(
        422,
        'INVALID_BUNDLED_SCORE_EXPORT',
        'The bundled MusicXML export for this score is invalid. Regenerate it from the matching source score.',
        { cause: error },
      );
    }
  }
  throw new AppError(409, 'SCORE_STILL_CHANGING', 'The score is still being copied. Wait a moment and try again.');
}

async function converterFingerprint(executablePath: string): Promise<string> {
  const resolved = await realpath(executablePath);
  const details = await stat(resolved);
  return `${resolved}|${details.size}|${details.mtimeMs}`;
}

function runMuseScore(executablePath: string, inputPath: string, outputPath: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executablePath,
      ['-R', '-o', outputPath, inputPath],
      {
        cwd,
        shell: false,
        windowsHide: true,
        env: process.platform === 'win32'
          ? process.env
          : { ...process.env, QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM ?? 'offscreen' },
      },
    );

    let stderr = '';
    let settled = false;
    let timedOut = false;
    child.stdout.resume();
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AppError(503, 'MUSESCORE_FAILED', `MuseScore Studio could not start: ${error.message}`, { cause: error }));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CONVERSION_TIMEOUT_MS);

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new AppError(504, 'MUSESCORE_TIMEOUT', 'MuseScore Studio took too long to convert this score.'));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim().split(/\r?\n/).slice(-4).join(' ').slice(0, 600);
        reject(new AppError(
          422,
          'MUSESCORE_CONVERSION_FAILED',
          `MuseScore Studio could not convert this score${detail ? `: ${detail}` : '.'}`,
        ));
      }
    });
  });
}

let conversionQueue: Promise<void> = Promise.resolve();
const inFlight = new Map<string, Promise<{ xml: string; cacheStatus: 'hit' | 'miss' }>>();

async function serialized<T>(task: () => Promise<T>): Promise<T> {
  const previous = conversionQueue;
  let release!: () => void;
  conversionQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

export async function convertMuseScoreFile(
  sourcePath: string,
  cacheDirectory: string,
  executablePath: string,
): Promise<{ xml: string; cacheStatus: 'hit' | 'miss' }> {
  const snapshot = await stableSnapshot(sourcePath);
  const fingerprint = await converterFingerprint(executablePath);
  const cacheKey = createHash('sha256')
    .update(CONVERTER_VERSION)
    .update('\0')
    .update(fingerprint)
    .update('\0')
    .update(snapshot.bytes)
    .digest('hex');

  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const promise = serialized(async () => {
    await mkdir(cacheDirectory, { recursive: true });
    const cachedPath = path.join(cacheDirectory, `${cacheKey}.musicxml`);
    try {
      const cachedXml = decodeXmlBuffer(await readFile(cachedPath));
      assertMusicXml(cachedXml);
      return { xml: cachedXml, cacheStatus: 'hit' as const };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !(error instanceof AppError)) throw error;
      if (error instanceof AppError) await rm(cachedPath, { force: true });
    }

    const scratchDirectory = await mkdtemp(path.join(cacheDirectory, '.convert-'));
    const inputPath = path.join(scratchDirectory, `source${snapshot.extension}`);
    const outputPath = path.join(scratchDirectory, 'converted.musicxml');
    try {
      await writeFile(inputPath, snapshot.bytes, { flag: 'wx' });
      await runMuseScore(executablePath, inputPath, outputPath, scratchDirectory);
      const outputBytes = await readFile(outputPath).catch((error: NodeJS.ErrnoException) => {
        throw new AppError(
          422,
          'MUSESCORE_NO_OUTPUT',
          'MuseScore Studio reported success but did not create MusicXML output.',
          { cause: error },
        );
      });
      if (outputBytes.byteLength === 0) {
        throw new AppError(422, 'MUSESCORE_NO_OUTPUT', 'MuseScore Studio created an empty MusicXML file.');
      }
      const xml = decodeXmlBuffer(outputBytes);
      assertMusicXml(xml);
      await rename(outputPath, cachedPath).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      return { xml, cacheStatus: 'miss' as const };
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true });
    }
  });

  inFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(cacheKey);
  }
}
