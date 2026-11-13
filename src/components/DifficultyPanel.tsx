import { useState } from 'react';
import { DIFFICULTY_LABELS } from '../types';
import type { StudentDifficulty } from '../types';

export function DifficultyPanel({ value, onChange }: {
  value: StudentDifficulty | null;
  onChange: (value: StudentDifficulty | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3" data-preserve-measure-selection>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="student-difficulty-panel"
        onClick={() => setOpen(!open)}
        className="w-full rounded-lg border border-sage-200 px-3 py-2 text-left text-xs font-semibold text-sage-800 hover:bg-sage-50"
      >
        What Are You Struggling With?
        <span className="ml-2 font-normal text-slate-400">Optional</span>
      </button>
      {open && (
        <fieldset id="student-difficulty-panel" className="mt-2 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <legend className="sr-only">Choose your main difficulty</legend>
          {(Object.entries(DIFFICULTY_LABELS) as Array<[StudentDifficulty['kind'], string]>).map(([kind, label]) => (
            <label key={kind} className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
              <input type="radio" name="student-difficulty" value={kind} checked={value?.kind === kind}
                onChange={() => onChange(kind === 'other' ? { kind, details: '' } : { kind })}
                className="accent-sage-700" />
              {label}
            </label>
          ))}
          {value?.kind === 'other' && (
            <label className="block text-xs text-slate-600">
              Describe your difficulty
              <textarea value={value.details ?? ''} maxLength={500} rows={3}
                onChange={event => onChange({ kind: 'other', details: event.target.value })}
                className="mt-1 w-full resize-y rounded-lg border border-slate-300 bg-white p-2 text-xs focus:border-sage-500 focus:outline-none"
                placeholder="For example, I lose my place when the left hand changes position." />
              <span className="text-[11px] text-slate-400">Up to 500 characters.</span>
            </label>
          )}
          {value && <button type="button" data-preserve-measure-selection onClick={() => onChange(null)} className="text-xs font-semibold text-sage-700">Clear difficulty</button>}
          <p className="text-[11px] leading-4 text-slate-500">Analyze Measure applies your choice. More exercises uses the difficulty shown with the current analysis.</p>
        </fieldset>
      )}
      {!open && value && <p className="mt-1 text-[11px] text-sage-700">{DIFFICULTY_LABELS[value.kind]}</p>}
    </div>
  );
}
