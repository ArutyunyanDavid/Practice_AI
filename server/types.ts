export const SUPPORTED_EXTENSIONS = ['.mscz', '.mscx', '.musicxml', '.xml', '.mxl'] as const;

export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export interface ScoreSummary {
  id: string;
  title: string;
  composer: string | null;
  filename: string;
  relativePath: string;
  format: SupportedExtension;
  modifiedAt: string;
  sizeBytes: number;
  requiresConversion: boolean;
  isValid: boolean;
  issue: string | null;
}

export interface ScoreMetadata {
  title?: string;
  composer?: string;
}

export interface ScoreFile extends ScoreSummary {
  absolutePath: string;
}

export interface ScoreContent {
  xml: string;
  cacheStatus: 'hit' | 'miss' | 'not-needed' | 'preconverted';
}
