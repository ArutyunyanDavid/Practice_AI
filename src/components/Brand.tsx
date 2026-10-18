import { Music2 } from 'lucide-react';

interface BrandProps {
  compact?: boolean;
}

export function Brand({ compact = false }: BrandProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-10 place-items-center rounded-xl bg-ink text-white shadow-sm">
        <Music2 aria-hidden="true" className="size-5" strokeWidth={1.9} />
      </div>
      <div className={compact ? 'hidden sm:block' : ''}>
        <div className="text-[15px] font-semibold tracking-[-0.02em] text-ink">Practice Studio</div>
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">Score library</div>
      </div>
    </div>
  );
}
