import { describe, expect, it } from 'vitest';
import { selectionKey, selectionLabel, toggleMeasure } from '../src/selection';

const pickup = { index: 0, label: '0' };
const next = { index: 1, label: '12A' };
const third = { index: 2, label: '12B' };

describe('single measure selection', () => {
  it('replaces the selected measure, including adjacent measures', () => {
    expect(toggleMeasure(null, pickup)).toEqual([pickup]);
    expect(toggleMeasure([pickup], next)).toEqual([next]);
    expect(toggleMeasure([next], pickup)).toEqual([pickup]);
    expect(toggleMeasure([pickup], third)).toEqual([third]);
  });

  it('clears a repeated click and normalizes an older pair selection', () => {
    expect(toggleMeasure([pickup], pickup)).toBeNull();
    expect(toggleMeasure([pickup, next], third)).toEqual([third]);
  });

  it('uses source indexes for identity and printed labels for display', () => {
    expect(selectionLabel([pickup, next])).toBe('Measures 0–12A');
    expect(selectionKey('score', [pickup])).not.toBe(selectionKey('score', [pickup, next]));
    expect(selectionKey('score', [pickup, next])).not.toBe(selectionKey('other-score', [pickup, next]));
  });
});
