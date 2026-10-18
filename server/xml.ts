import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import { AppError } from './errors.js';
import type { ScoreMetadata } from './types.js';

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 150 * 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized = String(value).replace(/\s+/g, ' ').trim();
    return normalized || undefined;
  }
  if (value && typeof value === 'object' && '#text' in value) {
    return scalarText((value as Record<string, unknown>)['#text']);
  }
  return undefined;
}

export function decodeXmlBuffer(buffer: Uint8Array): string {
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return swapped.toString('utf16le');
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

export function parseXml(xml: string): Record<string, unknown> {
  if (/<!ENTITY\b/i.test(xml)) {
    throw new AppError(422, 'UNSAFE_XML', 'The score contains unsupported XML entity declarations.');
  }

  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (validation !== true) {
    const line = validation.err?.line;
    const suffix = line ? ` near line ${line}` : '';
    throw new AppError(422, 'INVALID_XML', `The score is not valid XML${suffix}.`);
  }

  try {
    return parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new AppError(422, 'INVALID_XML', 'The score could not be parsed as XML.', { cause: error });
  }
}

export function assertMusicXml(xml: string): Record<string, unknown> {
  const document = parseXml(xml);
  if (!document['score-partwise'] && !document['score-timewise']) {
    throw new AppError(
      422,
      'INVALID_MUSICXML',
      'The XML file is valid, but it does not contain a MusicXML score.',
    );
  }
  return document;
}

export function extractMusicXmlMetadata(xml: string): ScoreMetadata {
  const document = assertMusicXml(xml);
  const root = (document['score-partwise'] ?? document['score-timewise']) as Record<string, unknown>;
  const work = root.work as Record<string, unknown> | undefined;
  const identification = root.identification as Record<string, unknown> | undefined;
  const creators = asArray(identification?.creator as Record<string, unknown> | Record<string, unknown>[]);
  const composerNode = creators.find((creator) => {
    const type = scalarText(creator?.['@_type']);
    return type?.toLowerCase() === 'composer';
  });

  return {
    title: scalarText(work?.['work-title']) ?? scalarText(root['movement-title']),
    composer: scalarText(composerNode),
  };
}

export function extractMuseScoreMetadata(xml: string): ScoreMetadata {
  const document = parseXml(xml);
  const museScore = document.museScore as Record<string, unknown> | undefined;
  const score = museScore?.Score as Record<string, unknown> | undefined;
  if (!score) {
    throw new AppError(422, 'INVALID_MUSESCORE', 'The file does not contain a valid MuseScore score.');
  }

  const tags = asArray(score.metaTag as Record<string, unknown> | Record<string, unknown>[]);
  const values = new Map<string, string>();
  for (const tag of tags) {
    const name = scalarText(tag?.['@_name']);
    const value = scalarText(tag);
    if (name && value) values.set(name.toLowerCase(), value);
  }

  return {
    title: values.get('worktitle') ?? values.get('movementtitle'),
    composer: values.get('composer'),
  };
}

function safeArchivePath(candidate: string): string {
  const normalized = path.posix.normalize(candidate.replace(/\\/g, '/'));
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new AppError(422, 'INVALID_ARCHIVE', 'The score archive contains an unsafe file path.');
  }
  return normalized;
}

function unzipArchive(buffer: Uint8Array): Map<string, Uint8Array> {
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new AppError(413, 'SCORE_TOO_LARGE', 'The compressed score is larger than 50 MB.');
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buffer);
  } catch (error) {
    throw new AppError(422, 'INVALID_ARCHIVE', 'The compressed score could not be opened.', { cause: error });
  }

  let expandedBytes = 0;
  const safeEntries = new Map<string, Uint8Array>();
  for (const [entryName, contents] of Object.entries(entries)) {
    const safeName = safeArchivePath(entryName);
    expandedBytes += contents.byteLength;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new AppError(413, 'SCORE_TOO_LARGE', 'The expanded score archive is larger than 150 MB.');
    }
    safeEntries.set(safeName, contents);
  }
  return safeEntries;
}

export function extractMxlMusicXml(buffer: Uint8Array): string {
  const entries = unzipArchive(buffer);
  const containerBytes = entries.get('META-INF/container.xml');
  if (!containerBytes) {
    throw new AppError(422, 'INVALID_MXL', 'The MXL archive is missing META-INF/container.xml.');
  }

  const container = parseXml(decodeXmlBuffer(containerBytes));
  const containerRoot = container.container as Record<string, unknown> | undefined;
  const rootfiles = containerRoot?.rootfiles as Record<string, unknown> | undefined;
  const rootfile = asArray(rootfiles?.rootfile as Record<string, unknown> | Record<string, unknown>[])[0];
  const fullPath = scalarText(rootfile?.['@_full-path']);
  if (!fullPath) {
    throw new AppError(422, 'INVALID_MXL', 'The MXL archive does not name its MusicXML document.');
  }

  const scoreBytes = entries.get(safeArchivePath(fullPath));
  if (!scoreBytes) {
    throw new AppError(422, 'INVALID_MXL', 'The MusicXML document named by the MXL archive is missing.');
  }

  const xml = decodeXmlBuffer(scoreBytes);
  assertMusicXml(xml);
  return xml;
}

export function extractMsczMuseScoreXml(buffer: Uint8Array): string {
  const entries = unzipArchive(buffer);
  const scoreEntry = [...entries.entries()].find(([entryName]) => entryName.toLowerCase().endsWith('.mscx'));
  if (!scoreEntry) {
    throw new AppError(422, 'INVALID_MSCZ', 'The MSCZ archive does not contain an MSCX score.');
  }
  const xml = decodeXmlBuffer(scoreEntry[1]);
  extractMuseScoreMetadata(xml);
  return xml;
}
