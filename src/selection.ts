import type { MeasureSelection, SelectedMeasure } from './types';

export function selectionLabel(selection: MeasureSelection): string {
  return selection.length === 1
    ? `Measure ${selection[0].label}`
    : `Measures ${selection[0].label}–${selection[1].label}`;
}

export function selectionKey(scoreId: string, selection: MeasureSelection): string {
  return `${scoreId}:${selection.map((measure) => measure.index).join(',')}`;
}

export function toggleMeasure(selection: MeasureSelection | null, clicked: SelectedMeasure): MeasureSelection | null {
  return selection?.[0].index === clicked.index ? null : [clicked];
}
