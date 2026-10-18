import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { fetchHealth, fetchScores } from './api';
import { Library } from './components/Library';
import { isFeaturedScore, toFeaturedScore } from './featuredScore';
import type { HealthStatus, ScoreSummary } from './types';

const ScoreWorkspace = lazy(async () => {
  const module = await import('./components/ScoreWorkspace');
  return { default: module.ScoreWorkspace };
});

function libraryRequestedFromLocation(): boolean {
  return new URLSearchParams(window.location.search).get('view') === 'library';
}

export default function App() {
  const [scores, setScores] = useState<ScoreSummary[]>([]);
  const [selectedScore, setSelectedScore] = useState<ScoreSummary | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  const loadLibrary = useCallback(async (isRefresh = false, signal?: AbortSignal) => {
    if (isRefresh) setRefreshing(true);
    setError(null);
    try {
      const [library, healthStatus] = await Promise.all([
        fetchScores(signal),
        fetchHealth(signal),
      ]);
      setScannedAt(library.scannedAt);
      setHealth(healthStatus);

      const discovered = library.scores.find(isFeaturedScore);
      const featuredScore = discovered ? toFeaturedScore(discovered) : null;
      setScores(featuredScore ? [featuredScore] : []);

      if (!featuredScore) {
        setSelectedScore(null);
        setError('The featured Liszt score was not found in the scores folder.');
      } else if (featuredScore.isValid && !libraryRequestedFromLocation()) {
        setSelectedScore(featuredScore);
        const url = new URL(window.location.href);
        url.searchParams.delete('view');
        url.searchParams.set('score', featuredScore.id);
        window.history.replaceState({}, '', url);
      } else {
        setSelectedScore(null);
      }
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setError(loadError instanceof Error ? loadError.message : 'The library could not be loaded.');
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadLibrary(false, controller.signal);
    return () => controller.abort();
  }, [loadLibrary]);

  useEffect(() => {
    const onPopState = () => {
      if (libraryRequestedFromLocation()) {
        setSelectedScore(null);
        return;
      }
      const featuredScore = scores[0];
      setSelectedScore(featuredScore ?? null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [scores]);

  const openScore = (score: ScoreSummary) => {
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    url.searchParams.set('score', score.id);
    window.history.pushState({}, '', url);
    setSelectedScore(score);
  };

  const closeScore = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('score');
    url.searchParams.set('view', 'library');
    window.history.pushState({}, '', url);
    setSelectedScore(null);
  };

  if (loading && !libraryRequestedFromLocation()) {
    return (
      <div className="grid h-screen place-items-center bg-parchment" role="status">
        <div className="flex items-center gap-3 text-sm font-medium text-slate-600">
          <LoaderCircle aria-hidden="true" className="size-5 animate-spin text-sage-600" />
          Opening Liszt’s Transcendental Étude…
        </div>
      </div>
    );
  }

  if (selectedScore) {
    return (
      <Suspense fallback={(
        <div className="grid h-screen place-items-center bg-parchment" role="status">
          <div className="flex items-center gap-3 text-sm font-medium text-slate-600">
            <LoaderCircle aria-hidden="true" className="size-5 animate-spin text-sage-600" />
            Opening Liszt’s score…
          </div>
        </div>
      )}>
        <ScoreWorkspace score={selectedScore} onBack={closeScore} />
      </Suspense>
    );
  }

  return (
    <Library
      scores={scores}
      health={health}
      loading={loading}
      refreshing={refreshing}
      error={error}
      scannedAt={scannedAt}
      onRefresh={() => void loadLibrary(true)}
      onOpenScore={openScore}
    />
  );
}
