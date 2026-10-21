import type { ScoreMetadata } from './types.js';

const featuredMetadata = new Map<string, ScoreMetadata>([
  [
    'czerny_etude_49.mscz',
    {
      title: 'Czerny Étude No. 49',
      composer: 'Carl Czerny',
    },
  ],
  [
    'czerny_etude_50.mscz',
    {
      title: 'Czerny Étude No. 50',
      composer: 'Carl Czerny',
    },
  ],
]);

export function featuredMetadataFor(filename: string): ScoreMetadata | undefined {
  return featuredMetadata.get(filename.toLowerCase());
}
