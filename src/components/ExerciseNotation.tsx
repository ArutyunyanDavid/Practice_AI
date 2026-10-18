import { useEffect, useRef, useState } from 'react';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { AlertTriangle, LoaderCircle } from 'lucide-react';

interface ExerciseNotationProps {
  musicXml: string;
  title: string;
  exerciseNumber: number;
}

type RenderStatus = 'loading' | 'ready' | 'error';

function markRenderedSvgDecorative(container: HTMLElement): void {
  container.querySelectorAll('svg').forEach((svg) => {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  });
}

export function ExerciseNotation({
  musicXml,
  title,
  exerciseNumber,
}: ExerciseNotationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<RenderStatus>('loading');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let initializationStarted = false;
    let resizeFrame = 0;
    let observedWidth = 0;
    let osmd: OpenSheetMusicDisplay | null = null;

    setStatus('loading');
    container.replaceChildren();

    const fail = () => {
      if (disposed) return;
      try {
        osmd?.clear();
      } catch {
        // The error state below is sufficient when OSMD cannot clear itself.
      }
      container.replaceChildren();
      setStatus('error');
    };

    const render = (): boolean => {
      if (disposed || !osmd?.Sheet) return false;
      try {
        osmd.render();
        markRenderedSvgDecorative(container);
        return true;
      } catch {
        fail();
        return false;
      }
    };

    const initialize = async () => {
      if (disposed || initializationStarted) return;
      const width = Math.round(container.getBoundingClientRect().width);
      if (width < 80) return;

      initializationStarted = true;
      observedWidth = width;
      try {
        const instance = new OpenSheetMusicDisplay(container, {
          backend: 'svg',
          pageFormat: 'Endless',
          drawingParameters: 'compacttight',
          autoResize: false,
          disableCursor: true,
          drawTitle: false,
          drawSubtitle: false,
          drawComposer: false,
          drawCredits: false,
          drawPartNames: false,
          drawPartAbbreviations: false,
          drawMeasureNumbers: false,
          pageBackgroundColor: '#ffffff',
        });
        osmd = instance;
        instance.Zoom = 0.72;
        instance.EngravingRules.PageLeftMargin = 0.6;
        instance.EngravingRules.PageRightMargin = 0.6;
        instance.EngravingRules.PageTopMargin = 0.6;
        instance.EngravingRules.PageBottomMargin = 0.6;
        await instance.load(musicXml);
        if (disposed) return;
        if (render()) setStatus('ready');
      } catch {
        fail();
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = Math.round(container.getBoundingClientRect().width);
      if (!initializationStarted) {
        if (nextWidth >= 80) void initialize();
        return;
      }
      if (nextWidth < 80 || nextWidth === observedWidth || !osmd?.Sheet) return;
      observedWidth = nextWidth;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(render);
    });
    resizeObserver.observe(container);
    resizeFrame = requestAnimationFrame(() => void initialize());

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      cancelAnimationFrame(resizeFrame);
      try {
        osmd?.clear();
      } catch {
        // OSMD may still be resolving an asynchronous load during unmount.
      }
      container.replaceChildren();
    };
  }, [musicXml]);

  return (
    <div
      data-testid="exercise-notation"
      className="exercise-notation mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white"
      role="img"
      aria-label={`Musical notation for exercise ${exerciseNumber}: ${title}`}
      aria-busy={status === 'loading'}
    >
      <div ref={containerRef} className="w-full" />
      {status === 'loading' && (
        <div className="flex min-h-20 items-center justify-center gap-2 px-3 text-[11px] text-slate-400" role="status">
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
          Engraving exercise…
        </div>
      )}
      {status === 'error' && (
        <div className="flex min-h-20 items-center justify-center gap-2 px-3 text-[11px] text-red-700" data-testid="exercise-notation-error" role="alert">
          <AlertTriangle aria-hidden="true" className="size-3.5" />
          This exercise notation could not be displayed.
        </div>
      )}
    </div>
  );
}
