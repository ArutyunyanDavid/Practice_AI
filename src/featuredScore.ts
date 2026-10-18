import type { ScoreSummary } from './types';

export const FEATURED_SCORE_FILENAME = 'liszt-transcendental-etude-no-2-molto-vivace.mscz';
export const FEATURED_SCORE_TITLE = 'Transcendental Étude No. 2 (Molto Vivace)';
export const FEATURED_SCORE_COMPOSER = 'Franz Liszt';

export function toFeaturedScore(score: ScoreSummary): ScoreSummary {
  return {
    ...score,
    title: FEATURED_SCORE_TITLE,
    composer: FEATURED_SCORE_COMPOSER,
  };
}

export function isFeaturedScore(score: ScoreSummary): boolean {
  return score.filename.toLowerCase() === FEATURED_SCORE_FILENAME;
}
