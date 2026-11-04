import { useEffect, useRef, useState } from 'react';
import {
  GraphicalMeasure,
  OpenSheetMusicDisplay,
  PointF2D,
} from 'opensheetmusicdisplay';
import { AlertTriangle, LoaderCircle, MousePointer2 } from 'lucide-react';
import { fetchScoreXml } from '../api';
import type { ScoreSummary, MeasureSelection } from '../types';
import { toggleMeasure } from '../selection';

interface ScoreRendererProps {
  score: ScoreSummary;
  zoom: number;
  currentPage: number;
  selection: MeasureSelection | null;
  onSelectionChange: (selection: MeasureSelection | null) => void;
  onPageCountChange: (pageCount: number) => void;
}

function getRenderedPages(osmd: OpenSheetMusicDisplay): HTMLElement[] {
  return osmd.Drawer.Backends.map((backend) => backend.getRenderElement());
}

function getMeasureRegions(
  osmd: OpenSheetMusicDisplay,
  pageIndex: number,
) {
  const page = osmd.GraphicSheet.MusicPages[pageIndex];
  if (!page) return [];

  const regions: Array<{ measure: GraphicalMeasure; left: number; right: number; top: number; bottom: number }> = [];
  page.MusicSystems.forEach((system) => {
    const sourceColumns = new Map<number, GraphicalMeasure[]>();
    system.StaffLines.forEach((staffLine) => {
      staffLine.Measures.forEach((measure) => {
        if (!measure.parentSourceMeasure || measure.IsExtraGraphicalMeasure) return;
        const sourceIndex = measure.parentSourceMeasure.measureListIndex;
        const column = sourceColumns.get(sourceIndex) ?? [];
        column.push(measure);
        sourceColumns.set(sourceIndex, column);
      });
    });

    sourceColumns.forEach((measures) => {
      const bounds = measures.map((measure) => {
        const box = measure.PositionAndShape;
        return {
          left: box.AbsolutePosition.x + box.BorderLeft,
          right: box.AbsolutePosition.x + box.BorderRight,
          top: measure.ParentStaffLine.PositionAndShape.AbsolutePosition.y + measure.ParentStaffLine.TopLineOffset,
          bottom: measure.ParentStaffLine.PositionAndShape.AbsolutePosition.y + measure.ParentStaffLine.BottomLineOffset,
        };
      });
      const left = Math.min(...bounds.map((bound) => bound.left));
      const right = Math.max(...bounds.map((bound) => bound.right));
      const top = Math.min(...bounds.map((bound) => bound.top));
      const bottom = Math.max(...bounds.map((bound) => bound.bottom));
      regions.push({ measure: measures[0], left, right, top, bottom });
    });
  });

  return regions;
}

export function ScoreRenderer({
  score,
  zoom,
  currentPage,
  selection,
  onSelectionChange,
  onPageCountChange,
}: ScoreRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const selectionRef = useRef(selection);
  const zoomRef = useRef(zoom);
  const currentPageRef = useRef(currentPage);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onPageCountChangeRef = useRef(onPageCountChange);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    onPageCountChangeRef.current = onPageCountChange;
  }, [onPageCountChange]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  const syncHighlight = (osmd: OpenSheetMusicDisplay, currentSelection = selectionRef.current) => {
    getRenderedPages(osmd).forEach((page, pageIndex) => {
      page.querySelectorAll('[data-measure-highlight]').forEach((element) => element.remove());
      const svg = page.querySelector('svg');
      const region = getMeasureRegions(osmd, pageIndex).find(
        ({ measure }) => measure.parentSourceMeasure.measureListIndex === currentSelection?.[0].index,
      );
      if (!svg || !region) return;
      // SVG coordinates use ten pixels per engraving unit. The SVG's screen
      // transform handles zoom and scrolling for both this rectangle and clicks.
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('data-measure-highlight', String(currentSelection![0].index));
      rect.setAttribute('x', String(region.left * 10));
      rect.setAttribute('y', String(region.top * 10));
      rect.setAttribute('width', String((region.right - region.left) * 10));
      rect.setAttribute('height', String((region.bottom - region.top) * 10));
      rect.setAttribute('fill', '#4d875e');
      rect.setAttribute('fill-opacity', '0.24');
      rect.setAttribute('pointer-events', 'none');
      svg.appendChild(rect);
    });
  };

  const showCurrentPage = (osmd: OpenSheetMusicDisplay) => {
    const renderedPages = getRenderedPages(osmd);
    const pageCount = Math.max(1, renderedPages.length);
    const visiblePage = Math.min(pageCount, Math.max(1, currentPageRef.current));

    renderedPages.forEach((pageElement, pageIndex) => {
      const isVisible = pageIndex === visiblePage - 1;
      pageElement.hidden = !isVisible;
      pageElement.style.display = isVisible ? 'block' : 'none';
      pageElement.dataset.scorePage = String(pageIndex + 1);
      pageElement.setAttribute('aria-label', `Score page ${pageIndex + 1}`);
      pageElement.setAttribute('aria-hidden', String(!isVisible));
    });

    onPageCountChangeRef.current(pageCount);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = new AbortController();
    let disposed = false;
    let resizeFrame = 0;

    setLoading(true);
    setError(null);
    onSelectionChangeRef.current(null);
    container.replaceChildren();

    const osmd = new OpenSheetMusicDisplay(container, {
      backend: 'svg',
      pageFormat: 'A4_P',
      autoResize: false,
      drawTitle: true,
      drawSubtitle: false,
      drawComposer: true,
      drawMeasureNumbers: true,
      drawMeasureNumbersOnlyAtSystemStart: false,
      autoGenerateMultipleRestMeasuresFromRestMeasures: false,
      pageBackgroundColor: '#ffffff',
      disableCursor: true,
    });
    osmdRef.current = osmd;
    osmd.EngravingRules.RenderMultipleRestMeasures = false;
    osmd.EngravingRules.CursorIgnoreRepetitions = true;
    osmd.EngravingRules.PageLeftMargin = 2.5;
    osmd.EngravingRules.PageRightMargin = 2.5;

    const render = () => {
      if (disposed || !osmd.Sheet) return;
      osmd.Zoom = zoomRef.current;
      osmd.render();
      syncHighlight(osmd);
      showCurrentPage(osmd);
    };

    let observedWidth = Math.round(container.getBoundingClientRect().width);
    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = Math.round(container.getBoundingClientRect().width);
      if (nextWidth === observedWidth) return;
      observedWidth = nextWidth;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(render);
    });
    resizeObserver.observe(container);

    const handleClick = (event: MouseEvent) => {
      if (!osmd.Sheet || !osmd.GraphicSheet) return;
      try {
        const eventTarget = event.target;
        if (!(eventTarget instanceof Node)) return;
        const renderedPages = getRenderedPages(osmd);
        const pageIndex = renderedPages.findIndex((pageElement) => pageElement.contains(eventTarget));
        if (pageIndex < 0) return;

        const svg = renderedPages[pageIndex].querySelector('svg');
        const screenTransform = svg?.getScreenCTM();
        if (!svg || !screenTransform) return;
        const screenPoint = svg.createSVGPoint();
        screenPoint.x = event.clientX;
        screenPoint.y = event.clientY;
        const pagePoint = screenPoint.matrixTransform(screenTransform.inverse());
        const svgPoint = new PointF2D(pagePoint.x, pagePoint.y);
        const osmdPoint = osmd.GraphicSheet.svgToOsmd(svgPoint);
        const graphicalMeasure = getMeasureRegions(osmd, pageIndex).find(({ left, right, top, bottom }) =>
          osmdPoint.x >= left && osmdPoint.x <= right && osmdPoint.y >= top && osmdPoint.y <= bottom,
        )?.measure;
        if (!graphicalMeasure?.parentSourceMeasure) return;

        const clickedIndex = graphicalMeasure.parentSourceMeasure.measureListIndex;
        const source = osmd.Sheet.SourceMeasures[clickedIndex];
        if (!source) return;
        const next = toggleMeasure(selectionRef.current, {
          index: clickedIndex,
          label: String(source.getPrintedMeasureNumber() ?? source.MeasureNumberXML ?? clickedIndex + 1),
        });

        // A valid measure click owns the event; all other clicks bubble to the
        // workspace's outside-click handler and clear the visual selection.
        event.stopPropagation();
        selectionRef.current = next;
        onSelectionChangeRef.current(next);
        syncHighlight(osmd, next);
      } catch (clickError) {
        console.warn('Could not select that measure.', clickError);
      }
    };
    container.addEventListener('click', handleClick);

    void (async () => {
      try {
        const xml = await fetchScoreXml(score.id, controller.signal);
        if (disposed) return;
        await osmd.load(xml);
        if (disposed) return;
        osmd.Sheet.TitleString = score.title;
        osmd.Sheet.ComposerString = score.composer ?? '';
        render();
        setLoading(false);
      } catch (loadError) {
        if (disposed || controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : 'The score could not be rendered.');
        setLoading(false);
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      resizeObserver.disconnect();
      cancelAnimationFrame(resizeFrame);
      container.removeEventListener('click', handleClick);
      osmd.clear();
      if (osmdRef.current === osmd) osmdRef.current = null;
      container.replaceChildren();
    };
    // A retry intentionally rebuilds OSMD from a clean container.
  }, [score.composer, score.id, score.title, loadAttempt]);

  useEffect(() => {
    const osmd = osmdRef.current;
    if (!osmd?.Sheet) return;
    osmd.Zoom = zoom;
    osmd.render();
    syncHighlight(osmd);
    showCurrentPage(osmd);
  }, [zoom]);

  useEffect(() => {
    const osmd = osmdRef.current;
    if (osmd?.Sheet) showCurrentPage(osmd);
  }, [currentPage]);

  useEffect(() => {
    const osmd = osmdRef.current;
    if (osmd?.Sheet) syncHighlight(osmd, selection);
  }, [selection]);

  return (
    <div className="relative min-h-full bg-[#e9ebe7] p-2 sm:p-3 lg:p-4">
      <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 sm:top-4">
        {!loading && !error && !selection && (
          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-2 text-xs font-medium text-slate-600 shadow-md backdrop-blur">
            <MousePointer2 aria-hidden="true" className="size-3.5 text-sage-600" />
            Click a measure to begin
          </div>
        )}
      </div>

      <div className="relative mx-auto w-[800px] min-w-[800px] rounded-sm bg-white shadow-paper">
        <div
          ref={containerRef}
          data-testid="score-pages"
          data-render-zoom={zoom}
          className={`score-canvas w-full cursor-crosshair bg-white transition-opacity ${loading ? 'min-h-[520px] opacity-20' : 'opacity-100'}`}
          aria-label={`Sheet music for ${score.title}`}
        />

        {loading && (
          <div className="absolute inset-0 grid place-items-center" role="status">
            <div className="flex flex-col items-center gap-3 rounded-2xl bg-white/90 px-6 py-5 shadow-lg backdrop-blur">
              <LoaderCircle aria-hidden="true" className="size-6 animate-spin text-sage-600" />
              <span className="text-sm font-medium text-slate-600">
                {score.requiresConversion ? 'Preparing MusicXML…' : 'Engraving your score…'}
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 grid place-items-center bg-white p-6" role="alert">
            <div className="max-w-md text-center">
              <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-red-50 text-red-600">
                <AlertTriangle aria-hidden="true" className="size-6" />
              </div>
              <h2 className="text-lg font-semibold text-ink">This score could not be opened</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">{error}</p>
              <button
                type="button"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                className="mt-5 rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sage-700"
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
