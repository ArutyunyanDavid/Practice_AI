import type { ScoreMetadata } from './types.js';

const featuredMetadata = new Map<string, ScoreMetadata>([
  [
    'liszt-transcendental-etude-no-2-molto-vivace.mscz',
    {
      title: 'Transcendental Étude No. 2 (Molto Vivace)',
      composer: 'Franz Liszt',
    },
  ],
]);

export function featuredMetadataFor(filename: string): ScoreMetadata | undefined {
  return featuredMetadata.get(filename.toLowerCase());
}
