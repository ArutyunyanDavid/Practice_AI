import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { fetchHealth, fetchScores } from './api';
import { Library } from './components/Library';
import type { HealthStatus, ScoreSummary } from './types';

const ScoreWorkspace = lazy(async () => {
  const module = await import('./components/ScoreWorkspace');
  return { default: module.ScoreWorkspace };
});

function requestedScoreId(): string | null {
  return new URLSearchParams(window.location.search).get('score');
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
      setScores(library.scores);

      const scoreId = requestedScoreId();
      const requestedScore = scoreId
        ? library.scores.find((score) => score.id === scoreId && score.isValid)
        : undefined;
      setSelectedScore(requestedScore ?? null);

      if (scoreId && !requestedScore) {
        const url = new URL(window.location.href);
        url.searchParams.delete('score');
        url.searchParams.delete('view');
        window.history.replaceState({}, '', url);
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
      const scoreId = requestedScoreId();
      const requestedScore = scoreId
        ? scores.find((score) => score.id === scoreId && score.isValid)
        : undefined;
      setSelectedScore(requestedScore ?? null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [scores]);

  const openScore = (score: ScoreSummary) => {
    if (!score.isValid) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    url.searchParams.set('score', score.id);
    window.history.pushState({}, '', url);
    setSelectedScore(score);
  };

  const closeScore = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('score');
    url.searchParams.delete('view');
    window.history.pushState({}, '', url);
    setSelectedScore(null);
  };

  if (selectedScore) {
    return (
      <Suspense fallback={(
        <div className="grid h-screen place-items-center bg-parchment" role="status">
          <div className="flex items-center gap-3 text-sm font-medium text-slate-600">
            <LoaderCircle aria-hidden="true" className="size-5 animate-spin text-sage-600" />
            Opening {selectedScore.title}…
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
