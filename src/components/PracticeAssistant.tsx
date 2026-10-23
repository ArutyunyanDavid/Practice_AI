import {
  AlertCircle,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import type {
  AiConnectionStatus,
  MeasureAnalysis,
  ScoreSummary,
  SelectedMeasure,
} from '../types';
import { ExerciseNotation } from './ExerciseNotation';

interface PracticeAssistantProps {
  score: ScoreSummary;
  selection: SelectedMeasure | null;
  connection: AiConnectionStatus | null;
  checkingConnection: boolean;
  analysis: MeasureAnalysis | null;
  analysisError: string | null;
  loadingMeasure: SelectedMeasure | null;
  selectedMeasurePending: boolean;
  onClear: () => void;
  onTestConnection: () => void;
  onPrepareAnalyze: (measure: SelectedMeasure) => void;
  onAnalyze: () => void;
}

const connectionPresentation = {
  connected: {
    label: 'Connected',
    icon: CheckCircle2,
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    dotClassName: 'text-emerald-600',
  },
  not_verified: {
    label: 'Configured - Not Verified',
    icon: CircleAlert,
    className: 'border-sky-200 bg-sky-50 text-sky-800',
    dotClassName: 'text-sky-600',
  },
  not_configured: {
    label: 'Not Configured',
    icon: CircleAlert,
    className: 'border-amber-200 bg-amber-50 text-amber-800',
    dotClassName: 'text-amber-600',
  },
  connection_failed: {
    label: 'Connection Failed',
    icon: WifiOff,
    className: 'border-red-200 bg-red-50 text-red-700',
    dotClassName: 'text-red-600',
  },
} as const;

function ConnectionStatus({
  connection,
  checking,
  onTest,
}: {
  connection: AiConnectionStatus | null;
  checking: boolean;
  onTest: () => void;
}) {
  const presentation = connection ? connectionPresentation[connection.status] : null;
  const StatusIcon = presentation?.icon ?? LoaderCircle;

  return (
    <section className="border-b border-slate-200 px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">OpenAI connection</h3>
          <div
            className={`mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
              presentation?.className ?? 'border-slate-200 bg-slate-50 text-slate-500'
            }`}
            role="status"
            aria-live="polite"
          >
            <StatusIcon
              aria-hidden="true"
              className={`size-3.5 shrink-0 ${checking ? 'animate-spin' : ''} ${presentation?.dotClassName ?? 'text-slate-400'}`}
            />
            <span className="truncate">{checking && !connection ? 'Checking…' : presentation?.label ?? 'Checking…'}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onTest}
          disabled={checking}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 transition hover:border-sage-300 hover:text-sage-800 disabled:cursor-wait disabled:opacity-60"
        >
          <RefreshCw aria-hidden="true" className={`size-3.5 ${checking ? 'animate-spin' : ''}`} />
          Test AI Connection
        </button>
      </div>
      {connection && connection.status !== 'not_configured' && (
        <p className="mt-2 text-[11px] leading-4 text-slate-500">
          {connection.message}
          {connection.model
            ? ` Model: ${connection.model}. Reasoning: ${connection.reasoningEffort}.`
            : ''}
        </p>
      )}
      {connection?.status === 'not_configured' && (
        <p className="mt-1.5 text-[11px] leading-4 text-amber-800">
          On Render, add <code className="rounded bg-amber-100 px-1 py-0.5 font-mono">OPENAI_API_KEY</code> and <code className="rounded bg-amber-100 px-1 py-0.5 font-mono">OPENAI_MODEL</code> under Dashboard &gt; Environment, then deploy again. For local development, put both values in the private project-root <code className="rounded bg-amber-100 px-1 py-0.5 font-mono">.env</code> file and restart.
        </p>
      )}
    </section>
  );
}

export function PracticeAssistant({
  score,
  selection,
  connection,
  checkingConnection,
  analysis,
  analysisError,
  loadingMeasure,
  selectedMeasurePending,
  onClear,
  onTestConnection,
  onPrepareAnalyze,
  onAnalyze,
}: PracticeAssistantProps) {
  return (
    <aside className="flex h-full flex-col bg-white">
      <div className="border-b border-slate-200 px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-sage-100 text-sage-700">
            <BrainCircuit aria-hidden="true" className="size-4.5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-ink">Practice Assistant</h2>
            <p className="mt-0.5 text-xs leading-4 text-slate-500">Focused feedback for one measure at a time.</p>
          </div>
        </div>
      </div>

      <ConnectionStatus
        connection={connection}
        checking={checkingConnection}
        onTest={onTestConnection}
      />

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <section>
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Selected measure</h3>
            {selection && (
              <button type="button" onClick={onClear} className="text-xs font-semibold text-sage-700 hover:text-sage-900">
                Clear
              </button>
            )}
          </div>

          <div className={`rounded-xl border p-3.5 ${selection ? 'border-sage-200 bg-sage-50' : 'border-dashed border-slate-300 bg-slate-50'}`}>
            {selection ? (
              <div className="flex items-center gap-3">
                <span
                  data-selected-measure={selection.index}
                  className="grid size-9 shrink-0 place-items-center rounded-lg bg-white text-sm font-bold text-sage-700 shadow-sm"
                >
                  {selection.label}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-sage-900">Measure {selection.label}</p>
                  <p className="mt-0.5 truncate text-[11px] text-sage-700/75">{score.title}</p>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-500">No measure selected</p>
                <p className="mt-1 text-xs leading-4 text-slate-400">Click any measure in the score. Selecting another replaces it.</p>
              </>
            )}
          </div>
        </section>

        <button
          type="button"
          disabled={!selection || selectedMeasurePending}
          onPointerDown={() => {
            if (selection && !selectedMeasurePending) onPrepareAnalyze(selection);
          }}
          onClick={onAnalyze}
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-sage-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
        >
          {selectedMeasurePending
            ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            : <Sparkles aria-hidden="true" className="size-4" />}
          {selectedMeasurePending ? 'Analysis in progress…' : 'Analyze Measure'}
        </button>
        <p className="mt-1.5 text-center text-[11px] leading-4 text-slate-400">Analysis runs only when you click this button.</p>

        {loadingMeasure && (
          <div className="mt-4 flex gap-2.5 rounded-xl border border-sage-200 bg-sage-50 p-3 text-sage-800" role="status">
            <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin" />
            <div>
              <p className="text-xs font-semibold">Analyzing measure {loadingMeasure.label}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-sage-700">Balanced reasoning prioritizes a faster response while preserving careful musical analysis. Your previous analysis stays visible until this request succeeds.</p>
            </div>
          </div>
        )}

        {analysisError && (
          <div className="mt-4 flex gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3 text-red-800" role="alert">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="text-xs font-semibold">Analysis was not replaced</p>
              <p className="mt-0.5 text-[11px] leading-4 text-red-700">{analysisError}</p>
            </div>
          </div>
        )}

        <section className="mt-5" aria-label="Current measure analysis">
          <h3 className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Analysis & exercises</h3>
          {analysis ? (
            <div data-testid="measure-analysis" className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-100 p-4">
                <div className="flex items-center gap-2 text-sage-700">
                  <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-[0.1em]">Measure {analysis.measure.label}</span>
                </div>
                <h4 className="mt-2 text-sm font-semibold leading-5 text-ink">{analysis.scoreTitle}</h4>
                {analysis.composer && <p className="mt-0.5 text-xs text-slate-400">{analysis.composer}</p>}
                <p className="mt-3 whitespace-pre-line text-[13px] leading-5 text-slate-600">{analysis.analysis}</p>
              </div>

              <div className="space-y-3 p-3">
                {analysis.exercises.map((exercise, index) => (
                  <article
                    key={`${analysis.generatedAt}-${index}`}
                    data-testid="practice-exercise"
                    className="rounded-xl bg-slate-50 p-3.5"
                    aria-label={`Exercise ${index + 1}: ${exercise.title}`}
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-sage-100 text-xs font-bold text-sage-700">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <h5 className="text-sm font-semibold leading-5 text-slate-800">
                          {exercise.title}
                        </h5>
                        <div className="mt-1 space-y-1">
                          {exercise.explanationSentences.map((sentence, sentenceIndex) => (
                            <p
                              key={sentenceIndex}
                              data-testid="exercise-explanation-sentence"
                              className="text-xs leading-5 text-slate-600"
                            >
                              {sentence}
                            </p>
                          ))}
                        </div>
                      </div>
                    </div>
                    <ExerciseNotation
                      musicXml={exercise.musicXml}
                      title={exercise.title}
                      exerciseNumber={index + 1}
                    />
                  </article>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-7 text-center">
              <BrainCircuit aria-hidden="true" className="mx-auto size-5 text-slate-300" />
              <p className="mt-2 text-xs font-medium text-slate-500">No analysis yet</p>
              <p className="mt-1 text-[11px] leading-4 text-slate-400">Select a measure and click Analyze Measure.</p>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
