import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
} from 'lucide-react';
import {
  analyzeMeasure,
  ApiRequestError,
  fetchAiStatus,
  testAiConnection,
} from '../api';
import type {
  AiConnectionStatus,
  MeasureAnalysis,
  ScoreSummary,
  SelectedMeasure,
} from '../types';
import { Brand } from './Brand';
import { PracticeAssistant } from './PracticeAssistant';
import { ScoreRenderer } from './ScoreRenderer';

interface ScoreWorkspaceProps {
  score: ScoreSummary;
  onBack: () => void;
}

const SCORE_RENDER_SCALE = 0.7;
const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.8;

function measureRequestKey(scoreId: string, measure: SelectedMeasure): string {
  return `${scoreId}:${measure.index}`;
}

function analysisErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) {
      const retry = error.retryAfter ? ` Try again after ${error.retryAfter} seconds.` : ' Please wait a moment and try again.';
      return `The AI request limit was reached.${retry}`;
    }
    if (error.status === 504 || error.code === 'CLIENT_TIMEOUT') {
      return 'The AI analysis took too long to respond. Please try again.';
    }
    if (error.status === 409) {
      return 'That measure is already being analyzed.';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'The measure could not be analyzed. Please try again.';
}

export function ScoreWorkspace({ score, onBack }: ScoreWorkspaceProps) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [selection, setSelection] = useState<SelectedMeasure | null>(null);
  const [connection, setConnection] = useState<AiConnectionStatus | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(true);
  const [analysis, setAnalysis] = useState<MeasureAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [loadingMeasure, setLoadingMeasure] = useState<SelectedMeasure | null>(null);
  const [inFlightMeasureKeys, setInFlightMeasureKeys] = useState<ReadonlySet<string>>(() => new Set());
  const viewportRef = useRef<HTMLElement>(null);
  const selectionRef = useRef<SelectedMeasure | null>(null);
  const preparedAnalysisRef = useRef<{ measure: SelectedMeasure; capturedAt: number } | null>(null);
  const requestSequenceRef = useRef(0);
  const latestRequestRef = useRef(0);
  const connectionSequenceRef = useRef(0);
  const testingConnectionRef = useRef(false);
  const inFlightMeasureKeysRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const [assistantOpen, setAssistantOpen] = useState(
    () => window.matchMedia('(min-width: 1024px)').matches,
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++connectionSequenceRef.current;
    setCheckingConnection(true);

    void fetchAiStatus(controller.signal)
      .then((status) => {
        if (mountedRef.current && sequence === connectionSequenceRef.current) setConnection(status);
      })
      .catch((statusError: unknown) => {
        if (controller.signal.aborted || sequence !== connectionSequenceRef.current) return;
        setConnection({
          status: 'connection_failed',
          model: null,
          reasoningEffort: 'medium',
          message: statusError instanceof Error ? statusError.message : 'The AI status could not be checked.',
        });
      })
      .finally(() => {
        if (mountedRef.current && !controller.signal.aborted && sequence === connectionSequenceRef.current) {
          setCheckingConnection(false);
        }
      });

    return () => controller.abort();
  }, []);

  const handleSelectionChange = useCallback((nextSelection: SelectedMeasure | null) => {
    selectionRef.current = nextSelection;
    if (nextSelection) preparedAnalysisRef.current = null;
    setSelection(nextSelection);
  }, []);

  useEffect(() => {
    const clearSelectionFromOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-preserve-measure-selection]')) return;
      handleSelectionChange(null);
    };
    document.addEventListener('click', clearSelectionFromOutsideClick);
    return () => document.removeEventListener('click', clearSelectionFromOutsideClick);
  }, [handleSelectionChange]);

  const handleTestConnection = useCallback(async () => {
    if (testingConnectionRef.current) return;
    testingConnectionRef.current = true;
    const sequence = ++connectionSequenceRef.current;
    setCheckingConnection(true);

    try {
      const status = await testAiConnection();
      if (mountedRef.current && sequence === connectionSequenceRef.current) setConnection(status);
    } catch (testError) {
      if (mountedRef.current && sequence === connectionSequenceRef.current) {
        setConnection({
          status: 'connection_failed',
          model: null,
          reasoningEffort: 'medium',
          message: testError instanceof Error ? testError.message : 'The OpenAI connection test failed.',
        });
      }
    } finally {
      if (sequence === connectionSequenceRef.current) {
        testingConnectionRef.current = false;
        if (mountedRef.current) setCheckingConnection(false);
      }
    }
  }, []);

  const beginAnalysis = useCallback(async (measure: SelectedMeasure) => {
    const requestKey = measureRequestKey(score.id, measure);
    if (inFlightMeasureKeysRef.current.has(requestKey)) return;

    const requestNumber = ++requestSequenceRef.current;
    latestRequestRef.current = requestNumber;
    inFlightMeasureKeysRef.current.add(requestKey);
    setInFlightMeasureKeys(new Set(inFlightMeasureKeysRef.current));
    setLoadingMeasure(measure);
    setAnalysisError(null);

    try {
      const response = await analyzeMeasure(score.id, measure, `request-${requestNumber}`);
      if (!mountedRef.current || requestNumber !== latestRequestRef.current) return;
      setAnalysis(response.analysis);
    } catch (requestError) {
      if (!mountedRef.current || requestNumber !== latestRequestRef.current) return;
      setAnalysisError(analysisErrorMessage(requestError));
      if (requestError instanceof ApiRequestError) {
        if (requestError.code === 'OPENAI_NOT_CONFIGURED') {
          setConnection({
            status: 'not_configured',
            model: null,
            reasoningEffort: 'medium',
            message: requestError.message,
          });
        } else if (
          requestError.code?.startsWith('OPENAI_')
          && requestError.code !== 'OPENAI_RATE_LIMITED'
        ) {
          setConnection((current) => ({
            status: 'connection_failed',
            model: current?.model ?? null,
            reasoningEffort: current?.reasoningEffort ?? 'medium',
            message: requestError.message,
          }));
        }
      }
    } finally {
      inFlightMeasureKeysRef.current.delete(requestKey);
      if (mountedRef.current) {
        setInFlightMeasureKeys(new Set(inFlightMeasureKeysRef.current));
        if (requestNumber === latestRequestRef.current) setLoadingMeasure(null);
      }
    }
  }, [score.id]);

  const prepareAnalysis = useCallback((measure: SelectedMeasure) => {
    preparedAnalysisRef.current = { measure, capturedAt: Date.now() };
  }, []);

  const handleAnalyze = useCallback(() => {
    const prepared = preparedAnalysisRef.current;
    preparedAnalysisRef.current = null;
    const measure = prepared && Date.now() - prepared.capturedAt < 5_000
      ? prepared.measure
      : selectionRef.current;
    if (measure) void beginAnalysis(measure);
  }, [beginAnalysis]);

  const changeZoom = (nextZoom: number) => {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(nextZoom.toFixed(2)))));
  };

  const changePage = (nextPage: number) => {
    const clampedPage = Math.min(pageCount, Math.max(1, nextPage));
    setCurrentPage(clampedPage);
    viewportRef.current?.scrollTo({ top: 0, left: 0 });
  };

  const handlePageCountChange = useCallback((nextPageCount: number) => {
    setPageCount(nextPageCount);
    setCurrentPage((page) => Math.min(page, nextPageCount));
  }, []);

  const selectedMeasurePending = selection
    ? inFlightMeasureKeys.has(measureRequestKey(score.id, selection))
    : false;

  return (
    <div className="flex h-screen min-h-[640px] flex-col overflow-hidden bg-white text-ink">
      <header className="z-30 flex h-[60px] shrink-0 items-center border-b border-slate-200 bg-white px-2 sm:px-4">
        <button
          type="button"
          onClick={onBack}
          className="mr-1 flex h-9 shrink-0 items-center gap-2 rounded-lg px-2 text-slate-600 transition hover:bg-slate-100 hover:text-ink sm:mr-3 sm:px-3"
          aria-label="Back to Library"
        >
          <ArrowLeft aria-hidden="true" className="size-5" />
          <span className="hidden text-sm font-semibold lg:inline">Back to Library</span>
        </button>
        <Brand compact />

        <div className="mx-4 hidden min-w-0 flex-1 border-l border-slate-200 pl-4 md:block xl:mx-6 xl:pl-6">
          <h1 className="truncate text-sm font-semibold text-ink">{score.title}</h1>
          <p className="truncate text-xs text-slate-400">{score.composer ?? 'Composer not listed'}</p>
        </div>

        <nav
          data-preserve-measure-selection
          className="ml-auto flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5 md:ml-0"
          aria-label="Score pages"
        >
          <button
            type="button"
            onClick={() => changePage(currentPage - 1)}
            disabled={currentPage <= 1}
            className="grid size-8 place-items-center rounded-md text-slate-600 transition hover:bg-white hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Previous page"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </button>
          <span
            data-testid="page-indicator"
            className="min-w-[4rem] px-1 text-center text-[11px] font-semibold tabular-nums text-slate-600 sm:min-w-[6.5rem] sm:text-xs"
          >
            <span className="hidden sm:inline">Page </span>{currentPage} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => changePage(currentPage + 1)}
            disabled={currentPage >= pageCount}
            className="grid size-8 place-items-center rounded-md text-slate-600 transition hover:bg-white hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Next page"
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        </nav>

        <div data-preserve-measure-selection className="ml-1.5 flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5 sm:ml-2">
          <button
            type="button"
            onClick={() => changeZoom(zoom - 0.1)}
            disabled={zoom <= MIN_ZOOM}
            className="grid size-8 place-items-center rounded-md text-slate-600 transition hover:bg-white hover:shadow-sm disabled:opacity-30"
            aria-label="Zoom out"
          >
            <Minus aria-hidden="true" className="size-4" />
          </button>
          <span className="hidden w-11 text-center text-xs font-semibold tabular-nums text-slate-600 sm:block">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => changeZoom(zoom + 0.1)}
            disabled={zoom >= MAX_ZOOM}
            className="grid size-8 place-items-center rounded-md text-slate-600 transition hover:bg-white hover:shadow-sm disabled:opacity-30"
            aria-label="Zoom in"
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => changeZoom(DEFAULT_ZOOM)}
            className="hidden size-8 place-items-center rounded-md text-slate-500 transition hover:bg-white hover:shadow-sm xl:grid"
            aria-label="Reset zoom"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
          </button>
        </div>

        <button
          type="button"
          data-preserve-measure-selection
          onClick={() => setAssistantOpen((open) => !open)}
          className="ml-1.5 grid size-9 place-items-center rounded-lg border border-slate-200 text-slate-600 transition hover:bg-slate-50 sm:ml-2"
          aria-label={assistantOpen ? 'Hide practice assistant' : 'Show practice assistant'}
        >
          {assistantOpen
            ? <PanelRightClose aria-hidden="true" className="size-5" />
            : <PanelRightOpen aria-hidden="true" className="size-5" />}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <main ref={viewportRef} className="min-w-0 grow basis-3/5 overflow-auto">
          <ScoreRenderer
            score={score}
            zoom={Number((zoom * SCORE_RENDER_SCALE).toFixed(3))}
            currentPage={currentPage}
            selection={selection}
            onSelectionChange={handleSelectionChange}
            onPageCountChange={handlePageCountChange}
          />
        </main>

        {assistantOpen && (
          <div
            data-testid="practice-assistant"
            className="fixed inset-x-3 bottom-3 z-40 max-h-[68vh] overflow-hidden rounded-2xl border border-slate-200 shadow-2xl lg:static lg:z-auto lg:max-h-none lg:min-w-[360px] lg:basis-2/5 lg:shrink-0 lg:rounded-none lg:border-0 lg:border-l lg:shadow-none"
          >
            <button
              type="button"
              data-preserve-measure-selection
              onClick={() => setAssistantOpen(false)}
              className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-lg bg-slate-100 text-slate-500 lg:hidden"
              aria-label="Close practice assistant"
            >
              <PanelRightClose aria-hidden="true" className="size-4" />
            </button>
            <div className="max-h-[68vh] overflow-auto lg:h-full lg:max-h-none lg:overflow-visible">
              <PracticeAssistant
                score={score}
                selection={selection}
                connection={connection}
                checkingConnection={checkingConnection}
                analysis={analysis}
                analysisError={analysisError}
                loadingMeasure={loadingMeasure}
                selectedMeasurePending={selectedMeasurePending}
                onClear={() => handleSelectionChange(null)}
                onTestConnection={() => void handleTestConnection()}
                onPrepareAnalyze={prepareAnalysis}
                onAnalyze={handleAnalyze}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
