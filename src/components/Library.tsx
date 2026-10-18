import { AlertCircle, ArrowRight, FileMusic, FolderOpen, RefreshCw, Sparkles } from 'lucide-react';
import type { HealthStatus, ScoreSummary } from '../types';
import { Brand } from './Brand';

interface LibraryProps {
  scores: ScoreSummary[];
  health: HealthStatus | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  scannedAt: string | null;
  onRefresh: () => void;
  onOpenScore: (score: ScoreSummary) => void;
}

function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLabel(format: ScoreSummary['format']): string {
  return format.slice(1).toUpperCase();
}

function LibrarySkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading scores">
      {[0, 1, 2].map((item) => (
        <div key={item} className="h-52 animate-pulse rounded-2xl border border-slate-200 bg-white p-5">
          <div className="mb-8 size-11 rounded-xl bg-slate-100" />
          <div className="mb-3 h-5 w-2/3 rounded bg-slate-100" />
          <div className="h-4 w-1/3 rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

export function Library({
  scores,
  health,
  loading,
  refreshing,
  error,
  scannedAt,
  onRefresh,
  onOpenScore,
}: LibraryProps) {
  const validScores = scores.filter((score) => score.isValid);
  const nativeCount = scores.filter((score) => score.requiresConversion).length;

  return (
    <div className="min-h-screen bg-parchment text-ink">
      <header className="border-b border-slate-200/80 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-20 max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-12">
          <Brand />
          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 shadow-sm">
            <span className={`size-2 rounded-full ${health?.museScore.available ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            <span className="hidden sm:inline">
              {health?.museScore.available ? 'MuseScore ready' : 'MusicXML ready'}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-5 pb-16 pt-10 sm:px-8 lg:px-12 lg:pt-14">
        <section className="mb-10 grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-sage-100 px-3 py-1.5 text-xs font-semibold text-sage-700">
              <Sparkles aria-hidden="true" className="size-3.5" />
              Featured repertoire
            </div>
            <h1 className="max-w-3xl font-display text-4xl font-semibold leading-[1.08] tracking-[-0.035em] text-ink sm:text-5xl lg:text-[58px]">
              Liszt, ready for<br />focused work.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600">
              This practice space is currently centered on Transcendental Étude No. 2. Open it to study the score and mark a focused passage.
            </p>
          </div>

          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex h-11 items-center justify-center gap-2 self-end rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-sage-400 hover:text-sage-700 disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw aria-hidden="true" className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh library
          </button>
        </section>

        <section className="mb-7 flex flex-wrap items-center justify-between gap-4 border-y border-slate-200 py-4">
          <div className="flex flex-wrap items-center gap-x-7 gap-y-2 text-sm text-slate-500">
            <span><strong className="font-semibold text-ink">{scores.length}</strong> {scores.length === 1 ? 'score' : 'scores'}</span>
            <span><strong className="font-semibold text-ink">{nativeCount}</strong> MuseScore {nativeCount === 1 ? 'file' : 'files'}</span>
            {scannedAt && <span>Scanned {new Date(scannedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <FolderOpen aria-hidden="true" className="size-4" />
            <span className="max-w-[280px] truncate" title={health?.scoresDirectory}>/scores</span>
          </div>
        </section>

        {error && (
          <div className="mb-6 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <div>
              <div className="font-semibold">The library could not be refreshed</div>
              <div className="mt-0.5 text-red-700">{error}</div>
            </div>
          </div>
        )}

        {loading ? (
          <LibrarySkeleton />
        ) : scores.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center shadow-soft">
            <div className="mx-auto mb-5 grid size-16 place-items-center rounded-2xl bg-sage-50 text-sage-700">
              <FileMusic aria-hidden="true" className="size-7" strokeWidth={1.7} />
            </div>
            <h2 className="font-display text-2xl font-semibold text-ink">Your music shelf is ready</h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-500">
              Add a .mscz, .mscx, .musicxml, .xml, or .mxl file to the project’s <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">scores</code> folder, then refresh.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {scores.map((score, index) => (
              <article
                key={score.id}
                className="group flex min-h-56 flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_2px_12px_rgba(24,39,30,0.03)] transition duration-200 hover:-translate-y-0.5 hover:border-sage-300 hover:shadow-soft"
                style={{ animationDelay: `${Math.min(index * 45, 240)}ms` }}
              >
                <div className="mb-7 flex items-start justify-between gap-4">
                  <div className="grid size-11 place-items-center rounded-xl bg-sage-50 text-sage-700 transition group-hover:bg-sage-100">
                    <FileMusic aria-hidden="true" className="size-5" strokeWidth={1.8} />
                  </div>
                  <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-bold tracking-[0.12em] text-slate-500">
                    {formatLabel(score.format)}
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-lg font-semibold tracking-[-0.02em] text-ink" title={score.title}>{score.title}</h2>
                  <p className="mt-1 truncate text-sm text-slate-500">{score.composer ?? 'Composer not listed'}</p>
                  <p className="mt-3 truncate text-xs text-slate-400" title={score.relativePath}>{score.relativePath} · {readableBytes(score.sizeBytes)}</p>
                  {!score.isValid && (
                    <p className="mt-3 line-clamp-2 text-xs leading-5 text-red-600" title={score.issue ?? undefined}>{score.issue}</p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => onOpenScore(score)}
                  disabled={!score.isValid}
                  className="mt-5 inline-flex h-10 w-full items-center justify-between rounded-xl bg-ink px-4 text-sm font-semibold text-white transition hover:bg-sage-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                >
                  <span>{score.isValid ? 'Open sheet music' : 'Invalid score'}</span>
                  <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
                </button>
              </article>
            ))}
          </div>
        )}

        {scores.length > 0 && validScores.length === 0 && (
          <p className="mt-5 text-center text-sm text-slate-500">No valid scores are available yet.</p>
        )}
      </main>
    </div>
  );
}
