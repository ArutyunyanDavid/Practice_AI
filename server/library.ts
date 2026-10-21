import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { featuredMetadataFor } from './featured.js';
import {
  BUNDLED_MUSICXML_DIRECTORY,
  convertMuseScoreFile,
  findMuseScoreExecutable,
  readBundledMusicXmlExport,
} from './musescore.js';
import {
  assertMusicXml,
  decodeXmlBuffer,
  extractMsczMuseScoreXml,
  extractMxlMusicXml,
  extractMuseScoreMetadata,
  extractMusicXmlMetadata,
} from './xml.js';
import { SUPPORTED_EXTENSIONS } from './types.js';
import type { ScoreContent, ScoreFile, ScoreMetadata, ScoreSummary, SupportedExtension } from './types.js';

const nativeMuseScoreExtensions = new Set<SupportedExtension>(['.mscz', '.mscx']);
const supported = new Set<string>(SUPPORTED_EXTENSIONS);

function stableId(relativePath: string): string {
  return createHash('sha256').update(relativePath.replace(/\\/g, '/')).digest('hex');
}

function fallbackTitle(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function issueMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The score could not be read.';
}

async function filesRecursively(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesRecursively(entryPath));
    } else if (entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files;
}

async function readMetadata(filePath: string, extension: SupportedExtension): Promise<ScoreMetadata> {
  const bytes = await readFile(filePath);
  if (extension === '.mxl') return extractMusicXmlMetadata(extractMxlMusicXml(bytes));
  if (extension === '.mscz') return extractMuseScoreMetadata(extractMsczMuseScoreXml(bytes));
  const xml = decodeXmlBuffer(bytes);
  return extension === '.mscx' ? extractMuseScoreMetadata(xml) : extractMusicXmlMetadata(xml);
}

export interface ScoreLibraryOptions {
  scoresDirectory: string;
  cacheDirectory: string;
  museScorePath?: string;
  museScoreResolver?: () => Promise<string | null>;
}

export class ScoreLibrary {
  readonly scoresDirectory: string;
  readonly cacheDirectory: string;
  readonly bundledExportsDirectory: string;
  private readonly configuredMuseScorePath?: string;
  private readonly resolveMuseScoreExecutable: () => Promise<string | null>;
  private museScorePromise?: Promise<string | null>;
  private readonly metadataCache = new Map<string, { signature: string; metadata: ScoreMetadata }>();

  constructor(options: ScoreLibraryOptions) {
    this.scoresDirectory = path.resolve(options.scoresDirectory);
    this.cacheDirectory = path.resolve(options.cacheDirectory);
    this.bundledExportsDirectory = path.join(this.scoresDirectory, BUNDLED_MUSICXML_DIRECTORY);
    this.configuredMuseScorePath = options.museScorePath;
    this.resolveMuseScoreExecutable = options.museScoreResolver
      ?? (() => findMuseScoreExecutable(this.configuredMuseScorePath));
  }

  async museScoreExecutable(): Promise<string | null> {
    this.museScorePromise ??= this.resolveMuseScoreExecutable();
    return this.museScorePromise;
  }

  private async toScoreFile(absolutePath: string): Promise<ScoreFile> {
    const details = await stat(absolutePath);
    const relativePath = path.relative(this.scoresDirectory, absolutePath).replace(/\\/g, '/');
    const extension = path.extname(absolutePath).toLowerCase() as SupportedExtension;
    const displayOverride = featuredMetadataFor(path.basename(absolutePath));
    const signature = `${details.size}:${details.mtimeMs}`;
    let metadata: ScoreMetadata = {};
    let issue: string | null = null;

    const cached = this.metadataCache.get(absolutePath);
    if (cached?.signature === signature) {
      metadata = cached.metadata;
    } else {
      try {
        metadata = await readMetadata(absolutePath, extension);
        this.metadataCache.set(absolutePath, { signature, metadata });
      } catch (error) {
        issue = issueMessage(error);
      }
    }

    return {
      id: stableId(relativePath),
      title: displayOverride?.title ?? metadata.title ?? fallbackTitle(absolutePath),
      composer: displayOverride?.composer ?? metadata.composer ?? null,
      filename: path.basename(absolutePath),
      relativePath,
      format: extension,
      modifiedAt: details.mtime.toISOString(),
      sizeBytes: details.size,
      requiresConversion: nativeMuseScoreExtensions.has(extension),
      isValid: issue === null,
      issue,
      absolutePath,
    };
  }

  async list(): Promise<ScoreSummary[]> {
    const files = await filesRecursively(this.scoresDirectory);
    const scores = await Promise.all(files.map((file) => this.toScoreFile(file)));
    return scores
      .map(({ absolutePath: _absolutePath, ...score }) => score)
      .sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }));
  }

  private async find(id: string): Promise<ScoreFile> {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new AppError(404, 'SCORE_NOT_FOUND', 'That score is not in the library.');
    }
    const files = await filesRecursively(this.scoresDirectory);
    for (const file of files) {
      const relativePath = path.relative(this.scoresDirectory, file).replace(/\\/g, '/');
      if (stableId(relativePath) === id) return this.toScoreFile(file);
    }
    throw new AppError(404, 'SCORE_NOT_FOUND', 'That score is not in the library. Refresh the library and try again.');
  }

  private async contentForScore(score: ScoreFile): Promise<ScoreContent> {
    if (!score.isValid) {
      throw new AppError(422, 'INVALID_SCORE', score.issue ?? 'The score file is invalid.');
    }

    if (score.format === '.mxl') {
      const xml = extractMxlMusicXml(await readFile(score.absolutePath));
      return { xml, cacheStatus: 'not-needed' };
    }

    if (!score.requiresConversion) {
      const xml = decodeXmlBuffer(await readFile(score.absolutePath));
      assertMusicXml(xml);
      return { xml, cacheStatus: 'not-needed' };
    }

    let bundledExportError: unknown;
    try {
      const bundled = await readBundledMusicXmlExport(score.absolutePath, this.bundledExportsDirectory);
      if (bundled) return { xml: bundled.xml, cacheStatus: 'preconverted' };
    } catch (error) {
      bundledExportError = error;
    }

    const executable = await this.museScoreExecutable();
    if (executable) {
      return convertMuseScoreFile(score.absolutePath, this.cacheDirectory, executable);
    }
    if (bundledExportError) throw bundledExportError;
    throw new AppError(
      503,
      'MUSESCORE_NOT_FOUND',
      'No matching bundled MusicXML export is available. Install MuseScore Studio 4 or set MUSESCORE_PATH to convert this score locally.',
    );
  }

  async content(id: string): Promise<ScoreContent> {
    return this.contentForScore(await this.find(id));
  }

  async analysisSource(id: string): Promise<{ score: ScoreSummary; xml: string }> {
    const scoreFile = await this.find(id);
    const { xml } = await this.contentForScore(scoreFile);
    const { absolutePath: _absolutePath, ...score } = scoreFile;
    return { score, xml };
  }
}
